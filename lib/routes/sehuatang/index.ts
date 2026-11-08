import { load } from 'cheerio';
import pMap from 'p-map';
import type { BrowserContext } from 'patchright';

import { config } from '@/config';
import type { DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import { getRouteLimit } from '@/utils/route-limit';
import timezone from '@/utils/timezone';

import { addCookies, getContext, playwrightGet } from './utils';

const forumIdMaps = {
    // 原创 BT 电影
    gcyc: '2', //     国产原创
    yzwmyc: '36', //  亚洲无码原创
    yzymyc: '37', //  亚洲有码原创
    gqzwzm: '103', // 高清中文字幕
    sjxz: '107', //   三级写真
    vr: '160', //     VR 视频
    srym: '104', //   素人有码
    omwm: '38', //    欧美无码
    '4k': '151', //   4K 原版
    hgzb: '152', //   韩国主播
    dmyc: '39', //    动漫原创
    // 色花图片
    yczp: '155', //   原创自拍
    ztzp: '125', //   转贴自拍
    hrjp: '50', //    华人街拍
    yzxa: '48', //    亚洲性爱
    omxa: '49', //    欧美性爱
    ktdm: '117', //   卡通动漫
    ttxz: '165', //   套图下载

    zhtl: '95', //    综合讨论
    // no longer updated/available
    mrhj: '106', //   每日合集
    ai: '113', //     AI 换脸电影
    ydsc: '111', //   原档收藏 WMV
    hrxazp: '98', //  华人性爱自拍
};

export const route: Route = {
    path: ['/bt/:subforumid?', '/picture/:subforumid', '/:subforumid?/:type?', '/:subforumid?', ''],
    categories: ['multimedia'],
    example: '/sehuatang/36/368',
    parameters: {
        subforumid: '版块 id 或板块名称（见下表）, 为空默认高清中文字幕',
        type: '类型 id, 可在分区类型过滤后的 URL 中找到',
    },
    name: 'Forum',
    maintainers: ['qiwihui', 'junfengP', 'nczitzk'],
    handler,
    features: {
        // Cloudflare-protected forum: every request has to go through a real browser.
        requirePuppeteer: true,
        nsfw: true,
        supportBT: true,
    },
    description: `**原创 BT 电影**

| 国产原创 | 亚洲无码原创 | 亚洲有码原创 | 高清中文字幕 | 三级写真 | VR 视频 | 素人有码 | 欧美无码 | 韩国主播 | 动漫原创 | 综合讨论 |
| -------- | ------------ | ------------ | ------------ | -------- | ------- | -------- | -------- | -------- | -------- | -------- |
| gcyc     | yzwmyc       | yzymyc       | gqzwzm       | sjxz     | vr      | srym     | omwm     | hgzb     | dmyc     | zhtl     |

**色花图片**

| 原创自拍 | 转贴自拍 | 华人街拍 | 亚洲性爱 | 欧美性爱 | 卡通动漫 | 套图下载 |
| -------- | -------- | -------- | -------- | -------- | -------- | -------- |
| yczp     | ztzp     | hrjp     | yzxa     | omxa     | ktdm     | ttxz     |`,
};

// The forum only sets its Cloudflare bypass cookie via an inline script on the home page,
// so the value has to be read from a rendered page and then handed to the browser context.
const getSafeId = (host: string, context: BrowserContext) =>
    cache.tryGet(
        `sehuatang:safeid:${host}`,
        async () => {
            const page = await context.newPage();
            try {
                await page.route('**/*', (route) => {
                    const request = route.request();
                    ['document', 'script'].includes(request.resourceType()) ? route.continue() : route.abort();
                });
                await page.goto(host, { waitUntil: 'domcontentloaded' });
                try {
                    await page.waitForFunction(() => [...document.querySelectorAll('script')].some((script) => script.textContent?.includes('safeid')), { timeout: 30000 });
                } catch {
                    logger.debug('[sehuatang] safeid script not found before timeout');
                }
                return await page.evaluate(() => {
                    for (const script of document.querySelectorAll('script')) {
                        const match = script.textContent?.match(/safeid\s*=\s*'(.+)';/);
                        if (match) {
                            return match[1];
                        }
                    }
                    return '';
                });
            } finally {
                await page.close();
            }
        },
        config.cache.routeExpire,
        false
    );

async function handler(ctx) {
    const domain = ctx.req.query('domain') ?? 'www.sehuatang.net';
    const host = `https://${domain}/`;
    const { subforumid: subforumName = 'gqzwzm', type } = ctx.req.param();
    const subforumId = Object.hasOwn(forumIdMaps, subforumName) ? forumIdMaps[subforumName] : subforumName;
    const typeFilter = type ? `&filter=typeid&typeid=${type}` : '';
    const link = `${host}forum.php?mod=forumdisplay&orderby=dateline&fid=${subforumId}${typeFilter}`;
    const limit = getRouteLimit(ctx, 25);

    const { context, destroy } = await getContext(host);
    try {
        const safeId = await getSafeId(host, context);
        logger.debug(`[sehuatang] safeid=${safeId ? 'ok' : 'missing'}, link=${link}`);

        if (safeId) {
            await addCookies(context, `_safe=${safeId}`, new URL(host).host);
        }
        const headers = { 'User-Agent': config.trueUA };

        const response = await playwrightGet(headers, link, context, '#threadlisttableid tbody[id^=normalthread]');
        const $ = load(response);
        logger.debug(`[sehuatang] list page length=${response.length}, threadRows=${$('#threadlisttableid tbody[id^=normalthread]').length}`);

        const list = $('#threadlisttableid tbody[id^=normalthread]')
            .slice(0, limit)
            .toArray()
            .map((item): DataItem => {
                const $item = $(item);
                const hasCategory = $item.find('th em a').length;
                const dateString = $item.find('td.by').find('em span span').attr('title');
                return {
                    title: $item.find('a.xst').text(),
                    category: hasCategory ? [$item.find('th em a').text()] : undefined,
                    link: host + $item.find('a.xst').attr('href'),
                    pubDate: dateString ? timezone(parseDate(dateString), 8) : undefined,
                    author: $item.find('td.by cite a').first().text(),
                };
            });

        const out = await pMap(
            list,
            async (info) => {
                const detail = await cache.tryGet(`${info.link}:details`, async () => {
                    const response = await playwrightGet(headers, info.link!, context, 'div[id^="postmessage"], td[id^="postmessage"]');

                    const $ = load(response);
                    const postMessage = $('div[id^="postmessage"], td[id^="postmessage"]').slice(0, 1);
                    if (!postMessage.length) {
                        throw new Error(`No public post body was found at ${info.link}.`);
                    }
                    const images = $(postMessage).find('img');
                    for (const image of images) {
                        const file = $(image).attr('file');
                        if (!file || file === 'undefined') {
                            $(image).replaceWith('');
                        } else {
                            $(image).replaceWith($(`<img src="${file}">`));
                        }
                    }
                    // also parse image url from `.pattl`
                    const pattl = $('.pattl');
                    const pattlImages = $(pattl).find('img');
                    for (const pattlImage of pattlImages) {
                        const file = $(pattlImage).attr('file');
                        if (!file || file === 'undefined') {
                            $(pattlImage).replaceWith('');
                        } else {
                            $(pattlImage).replaceWith($(`<img src="${file}" />`));
                        }
                    }
                    postMessage.append($(pattl));
                    $('em[onclick]').remove();

                    const dateString = $('.authi em span').attr('title');
                    const detail: Partial<DataItem> = {
                        description: (postMessage.html() || '抓取原帖失败').replaceAll('ignore_js_op', 'div'),
                        pubDate: dateString ? timezone(parseDate(dateString), 8) : undefined,
                    };

                    const magnet = postMessage.find('div.blockcode li').first().text();
                    const isMag = magnet.startsWith('magnet');
                    const torrent = postMessage.find('p.attnm a').attr('href');

                    const hasEnclosureUrl = isMag || torrent !== undefined;
                    if (hasEnclosureUrl) {
                        const enclosureUrl = isMag ? magnet : new URL(torrent!, host).href;
                        detail.enclosure_url = enclosureUrl;
                        detail.enclosure_type = isMag ? 'application/x-bittorrent' : 'application/octet-stream';
                    }

                    return detail;
                });
                return { ...info, ...detail, pubDate: detail.pubDate ?? info.pubDate };
            },
            { concurrency: 3 }
        );

        return {
            title: `色花堂 - ${$('#pt > div:nth-child(1) > a:last-child').text()}`,
            link,
            item: out,
        };
    } finally {
        await destroy();
    }
}
