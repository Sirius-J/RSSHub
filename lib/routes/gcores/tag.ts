import InvalidParameterError from '@/errors/types/invalid-parameter';
import { Route } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';
import { load } from 'cheerio';

export const route: Route = {
    path: '/tag/:tag/:category?',
    categories: ['new-media', 'popular'],
    example: '/gcores/tag/42/articles',
    parameters: { tag: '标签名，可在选定标签分类页面的 URL 中找到，如视觉动物——42', category: '分类名' },
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['gcores.com/categories/:tag', 'gcores.com/'],
            target: '/tag/:tag',
        },
    ],
    name: '标签',
    maintainers: ['StevenRCE0'],
    handler,
    description: `分类名同上。`,
};

async function handler(ctx) {
    const tag = ctx.req.param('tag');
    const category = ctx.req.param('category');
    const url = `https://www.gcores.com/categories/${tag + (category ? `?tab=${category}` : '')}`;
    const res = await got({
        method: 'get',
        url,
    });
    const data = res.data;
    const $ = load(data);
    const feedTitle = $('title').text();

    const list = $('.original.am_card.original-normal')
        .map(function () {
            const item = {
                url: $(this).find('.am_card_inner>a').attr('href'),
                title: $(this).find('h3.am_card_title').text(),
                category: $(this).find('span.original_category>a').text(),
            };
            return item;
        })
        .get();

    if (list.length > 0 && list.every((item) => item.url === undefined)) {
        throw new InvalidParameterError('Article URL not found! Please submit an issue on GitHub.');
    }

    const out = await Promise.all(
        list.map((item) => {
            const articleUrl = `https://www.gcores.com${item.url}`;

            return cache.tryGet(articleUrl, async () => {
                const itemRes = await got({
                    method: 'get',
                    url: articleUrl,
                });

                const itemPage = itemRes.data;
                const $ = load(itemPage);

                let articleData = await got(`https://www.gcores.com/gapi/v1${item.url}?include=media`);

                articleData = articleData.data.data;
                let cover;
                if (articleData.attributes.cover) {
                    cover = `<img src="https://image.gcores.com/${articleData.attributes.cover}" />`;
                } else if (articleData.attributes.thumb) {
                    cover = `<img src="https://image.gcores.com/${articleData.attributes.thumb}" />`;
                } else {
                    cover = '';
                }

                // replace figure with img
                const articleContent = JSON.parse(articleData.attributes.content);
                const entityRangeMap = {};
                for (const block of articleContent.blocks || []) {
                    if (block.entityRanges.length) {
                        entityRangeMap[block.key] = block.entityRanges;
                    }
                }

                $('figure').each((i, elem) => {
                    const keyAttr = elem.attribs['data-offset-key'];
                    const keyMatch = /^(\w+)-(\d+)-(\d)$/.exec(keyAttr);
                    let actualContent = '';
                    if (keyMatch) {
                        const [, key, index] = keyMatch;
                        if (entityRangeMap[key] && entityRangeMap[key][index]) {
                            const entityKey = entityRangeMap[key] && entityRangeMap[key][index].key;
                            const entity = articleContent.entityMap[entityKey];
                            actualContent = convertEntityToContent(entity);
                        }
                    }

                    if (actualContent) {
                        $(elem).replaceWith(actualContent);
                    }
                });

                // remove editor toolbar img
                $('.md-editor-toolbar').replaceWith('');
                // remove hidden tip block
                $('.story_hidden').replaceWith('');

                const content = $('.story.story-show').html();
                return {
                    title: item.title,
                    description: cover + content,
                    link: articleUrl,
                    guid: articleUrl,
                };
            });
        })
    );
    return {
        title: feedTitle,
        link: url,
        item: out,
    };
}

function convertEntityToContent(entity) {
    const { type, data } = entity;
    switch (type) {
        case 'IMAGE':
            return `
<figure>
<img src="https://image.gcores.com/${data.path}" alt="${data.caption || ''}">
${data.caption ? `<figcaption>${data.caption}</figcaption>` : ''}
</figure>`;

        case 'GALLERY':
            return data.images
                .map(
                    (image, i, arr) => `
<figure>
<img src="https://image.gcores.com/${image.path}" alt="${image.caption || ''}">
<figcaption>${data.caption || ''} (${i + 1}/${arr.length}) ${image.caption || ''}</figcaption>
</figure>
            `
                )
                .join('');

        default:
            return '';
    }
}
