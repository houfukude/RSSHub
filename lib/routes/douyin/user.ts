import { config } from '@/config';
import InvalidParameterError from '@/errors/types/invalid-parameter';
import type { Route } from '@/types';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';
import { getPlaywrightPage, type Page } from '@/utils/playwright';
import { fallback, queryToBoolean } from '@/utils/readable-social';

import type { ShareAweme, SharePostData, ShareRouterData, ShareUserInfo, UserInfoData } from './types';
import { getApiResponse, getOriginAvatar, proxyVideo, resolveUrl, templates } from './utils';

// The desktop page answers `/web/aweme/post/` with an empty body for anonymous headless
// requests, so the route reads the mobile share page instead, which still serves the full
// list from `/web/api/v2/aweme/post/`. See docs/DOUYIN-RSS-HANDOFF.md for the evidence.
const mobileUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const allowedResourceTypes = new Set(['document', 'script', 'xhr', 'fetch']);
// The share page serves `aweme/post` within 1-2 s when the account has works, so a shorter wait
// only cuts the cost of the accounts that never trigger the request.
const feedTimeout = 10000;
const emptyNoticePattern = /对方暂未发布内容|暂无内容/;

type ShareFeed = {
    awemeList: ShareAweme[];
    userInfo?: ShareUserInfo;
};

export const route: Route = {
    path: '/user/:uid/:routeParams?',
    categories: ['social-media'],
    example: '/douyin/user/MS4wLjABAAAARcAHmmF9mAG3JEixq_CdP72APhBlGlLVbN-1eBcPqao',
    parameters: { uid: 'uid，可在用户页面 URL 中找到', routeParams: '额外参数，query string 格式，请参阅上面的表格' },
    features: {
        requireConfig: false,
        requirePuppeteer: true,
        antiCrawler: true,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['douyin.com/user/:uid'],
            target: '/user/:uid',
        },
    ],
    name: '博主',
    maintainers: ['Max-Tortoise', 'Rongronggg9'],
    description: '数据取自抖音移动分享页。该页面不提供作品发布时间与视频直链，因此 pubDate 由作品 ID 反推（秒级，可能有分钟级偏差），description 仅含文案与封面图；embed /iframe/relay 参数在移动分享页下不产生视频播放器。',
    handler,
};

// The payload is a plain JSON object literal, so widening the slice until it parses is enough;
// a closing brace inside a string simply fails to parse and the scan keeps going.
const extractJsonObject = (text: string, marker: string) => {
    const markerIndex = text.indexOf(marker);
    const open = markerIndex === -1 ? -1 : text.indexOf('{', markerIndex + marker.length);
    if (open === -1) {
        return null;
    }
    for (let end = text.indexOf('}', open); end !== -1; end = text.indexOf('}', end + 1)) {
        const candidate = text.slice(open, end + 1);
        try {
            JSON.parse(candidate);
            return candidate;
        } catch {
            // not a complete object yet, keep widening
        }
    }
    return null;
};

// The share page inlines `window._ROUTER_DATA = {...}` (user profile, including the nickname
// and avatar). The variable itself is not always reachable on `globalThis` after hydration,
// so the payload is extracted from the inline script instead.
const readRouterData = async (page: Page) => {
    let scriptText = '';
    try {
        scriptText = await page.evaluate(() => {
            for (const script of document.querySelectorAll('script')) {
                const text = script.textContent ?? '';
                if (text.includes('_ROUTER_DATA')) {
                    return text;
                }
            }
            return '';
        });
    } catch (error) {
        logger.debug(`Failed to read _ROUTER_DATA: ${error}`);
        return null;
    }

    const json = extractJsonObject(scriptText, '_ROUTER_DATA');
    if (!json) {
        return null;
    }
    try {
        return JSON.parse(json) as ShareRouterData;
    } catch (error) {
        logger.debug(`Failed to parse _ROUTER_DATA: ${error}`);
        return null;
    }
};

const findUserInfo = (routerData?: ShareRouterData | null) => Object.values(routerData?.loaderData ?? {}).find((item) => item?.userInfoRes)?.userInfoRes?.user_info;

const hasNoWorks = (userInfo?: ShareUserInfo) => userInfo?.aweme_count === 0;

// The share page only requests `/web/api/v2/aweme/post` when the account has works, so waiting
// for it on an empty account blocks until the timeout. This legacy endpoint answers the same
// question over plain HTTP, which lets an empty account skip the browser entirely.
const probeUserInfo = async (uid: string) => {
    try {
        const data = (await ofetch(`https://www.iesdouyin.com/web/api/v2/user/info/?sec_uid=${uid}`, {
            headers: { 'User-Agent': mobileUserAgent },
            timeout: feedTimeout,
            retry: 0,
        })) as UserInfoData;
        return data?.status_code === 0 ? data.user_info : undefined;
    } catch (error) {
        logger.debug(`Douyin user info probe failed for ${uid}: ${error}`);
        return;
    }
};

// Only the second half of the empty-account check: a missing XHR on its own is not proof, since
// a layout change or a flaky network would then be reported as an account without works.
const showsEmptyNotice = async (page: Page) => {
    try {
        const text = await page.evaluate(() => document.body?.textContent ?? '');
        return emptyNoticePattern.test(text);
    } catch (error) {
        logger.debug(`Failed to read the share page text: ${error}`);
        return false;
    }
};

async function fetchSharePageOnce(uid: string): Promise<ShareFeed> {
    const shareUrl = `https://www.iesdouyin.com/share/user/${uid}`;
    const { page, context, destroy } = await getPlaywrightPage(shareUrl, { noGoto: true, closeTimeout: 0 });
    try {
        await page.route('**/*', (route) => {
            allowedResourceTypes.has(route.request().resourceType()) ? route.continue() : route.abort();
        });
        // The browser context is created with the desktop UA; the share page needs a mobile one.
        try {
            const client = await context.newCDPSession(page);
            await client.send('Emulation.setUserAgentOverride', { userAgent: mobileUserAgent, platform: 'iPhone', acceptLanguage: 'zh-CN,zh;q=0.9' });
            await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
        } catch (error) {
            logger.warn(`Failed to emulate a mobile device for ${shareUrl}: ${error}`);
        }

        logger.http(`Requesting ${shareUrl}`);
        let postData: SharePostData | undefined;
        try {
            postData = (await getApiResponse(page, shareUrl, '/web/api/v2/aweme/post', feedTimeout)) as SharePostData;
        } catch (error) {
            logger.debug(`Douyin share page did not serve ${shareUrl}: ${error}`);
        }
        const userInfo = findUserInfo(await readRouterData(page));

        if (postData?.aweme_list?.length) {
            return { awemeList: postData.aweme_list, userInfo };
        }

        // No list served: an account without works is a valid state, but only the page itself
        // can confirm it. Anything less certain stays an error so failures keep surfacing.
        if (hasNoWorks(userInfo) && (await showsEmptyNotice(page))) {
            logger.info(`Douyin account ${uid} has no published works, returning an empty feed.`);
            return { awemeList: [], userInfo };
        }

        throw new Error(postData ? 'Empty post data. The request may be filtered by WAF.' : 'Aweme list was not served and the page does not report an empty account.');
    } finally {
        await destroy();
    }
}

// Douyin answers with `200` and an empty body at random for anonymous headless requests,
// so a single failed attempt is retried once before giving up. An account without works is not
// an error and is not retried.
async function fetchSharePage(uid: string): Promise<ShareFeed> {
    const probe = await probeUserInfo(uid);
    if (hasNoWorks(probe)) {
        logger.info(`Douyin account ${uid} has no published works, returning an empty feed without opening a browser.`);
        return { awemeList: [], userInfo: probe };
    }

    try {
        return await fetchSharePageOnce(uid);
    } catch (error) {
        logger.warn(`Douyin share page first attempt failed, retrying once: ${error}`);
        return await fetchSharePageOnce(uid);
    }
}

// The mobile payload has no `create_time`; the top 32 bits of the snowflake-like aweme ID
// hold the publish timestamp in seconds.
const getPublishTime = (awemeId: string) => {
    if (!/^\d+$/.test(awemeId)) {
        return;
    }
    const seconds = Number(BigInt(awemeId) >> 32n);
    return seconds > 0 ? parseDate(seconds * 1000) : undefined;
};

async function handler(ctx) {
    const uid = ctx.req.param('uid');
    if (!uid.startsWith('MS4wLjABAAAA')) {
        throw new InvalidParameterError('Invalid UID. UID should start with <b>MS4wLjABAAAA</b>.');
    }
    const routeParams = Object.fromEntries(new URLSearchParams(ctx.req.param('routeParams')));
    const embed = fallback(undefined, queryToBoolean(routeParams.embed), false); // embed video
    const iframe = fallback(undefined, queryToBoolean(routeParams.iframe), false); // embed video in iframe
    const relay = resolveUrl(routeParams.relay, true, true); // embed video behind a reverse proxy

    const { awemeList, userInfo } = await cache.tryGet(`douyin:user:share:v2:${uid}`, () => fetchSharePage(uid), config.cache.routeExpire, false);

    const userNickName = userInfo?.nickname ?? uid;
    const userAvatar = getOriginAvatar(userInfo?.avatar_thumb?.url_list?.at(-1));

    const items = awemeList.map((post) => {
        // parse video
        let videoList = (post.video?.bit_rate ?? []).map((item) => resolveUrl(item.play_addr?.url_list?.at(-1))).filter(Boolean);
        if (relay && videoList.length > 0) {
            videoList = videoList.map((item) => proxyVideo(item, relay));
        }
        let duration = post.video?.duration;
        duration &&= duration / 1000;
        let img =
            post.video?.cover?.url_list?.at(-1) || // HD
            post.video?.origin_cover?.url_list?.at(-1); // LD
        img &&= resolveUrl(img);

        // render description
        const desc = post.desc?.replaceAll('\n', '<br>');
        let media = (embed && videoList.length > 0 ? templates.embed : templates.cover)({ img, videoList, duration });
        media = embed && videoList.length > 0 && iframe ? templates.iframe({ content: media }) : media; // warp in iframe

        return {
            title: post.desc ?? '',
            description: templates.desc({ desc: desc ?? '', media }),
            link: `https://www.douyin.com/video/${post.aweme_id}`,
            pubDate: getPublishTime(post.aweme_id),
            category: post.video_tag?.map((t) => t.tag_name),
        };
    });

    return {
        title: userNickName,
        link: `https://www.douyin.com/user/${uid}`,
        image: userAvatar,
        // An account without works is a valid state: it must not be reported as a broken feed.
        // Every uncertain case is still thrown from the fetch path above.
        allowEmpty: awemeList.length === 0,
        item: items,
    };
}
