import type { BrowserContext } from 'patchright';

import logger from '@/utils/logger';
import { getPlaywrightPage } from '@/utils/playwright';

const allowedResourceTypes = new Set(['document', 'script']);

// Opens a shared browser context that stays alive until the caller destroys it,
// so that Cloudflare cookies obtained on the first request survive the whole run.
const getContext = async (host: string) => {
    const { context, page, destroy } = await getPlaywrightPage(host, {
        noGoto: true,
        // 0 means "never auto-close"; the handler always awaits destroy() in finally.
        closeTimeout: 0,
    });
    await page.close();
    return { context, destroy };
};

// Sets a Cookie-header-style string as browser cookies so that the browser manages them (including Cloudflare cookies).
const addCookies = async (context: BrowserContext, cookieStr: string, domain: string) => {
    const cookies = cookieStr
        .split('; ')
        .map((item) => {
            const [name, value] = item.split('=', 2);
            return { domain, path: '/', name, value: value ?? '' };
        })
        .filter((c) => c.name);
    if (cookies.length > 0) {
        await context.addCookies(cookies);
    }
};

const playwrightGet = async (headers: Record<string, string>, link: string, context: BrowserContext, waitForSelector = '') => {
    logger.info(`Requesting ${link}`);
    const page = await context.newPage();
    try {
        // Only set the User-Agent here; cookies are managed by the browser context to keep Cloudflare cookies intact.
        if (headers['User-Agent']) {
            await page.setExtraHTTPHeaders({ 'User-Agent': headers['User-Agent'] });
        }
        await page.route('**/*', (route) => {
            const request = route.request();
            allowedResourceTypes.has(request.resourceType()) ? route.continue() : route.abort();
        });
        await page.goto(link, {
            waitUntil: 'domcontentloaded',
        });
        // Give Cloudflare challenge time to pass before extracting content.
        if (waitForSelector) {
            try {
                await page.waitForSelector(waitForSelector, { timeout: 30000 });
            } catch {
                // Return the loaded HTML even when the expected selector is missing.
            }
        }
        return await page.content();
    } finally {
        await page.close();
    }
};

export { addCookies, getContext, playwrightGet };
