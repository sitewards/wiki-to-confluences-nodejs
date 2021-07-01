const axios                 = require('axios').default;
const axiosCookieJarSupport = require('axios-cookiejar-support').default;
const tough                 = require('tough-cookie');
const http                  = require('http');
const https                 = require('https');
const fs                    = require('fs');
const path                  = require('path');
const querystring           = require('querystring');
const FormData              = require('form-data');
const Downloader            = require('nodejs-file-downloader');
const rax                   = require('retry-axios');

const PAGE_SIZE      = 100; // WARNING, jira cloud seem to have it hardcoded as 100
const VERBOSE_OUTPUT = 1;

// https://www.mediawiki.org/wiki/Manual:Namespace
const PAGE_NAMESPACES_TO_SYNC = [0];

const DELETE_EXISTING_PAGES = 1;

const TARGET_AUTH = {
    username: process.env.TARGET_CONFLUENCE_USER,
    password: process.env.TARGET_CONFLUENCE_PASSWORD
};

let logInfo;
if (VERBOSE_OUTPUT) {
    logInfo = console.log;
} else {
    logInfo = function () {
    };
}
let logError = console.error;

const axiosInstance = axios.create({
    timeout: 1000,
    raxConfig: {
        retry: 5, // number of retry when facing 4xx or 5xx
        noResponseRetries: 5, // number of retry when facing connection error
        onRetryAttempt: err => {
            const cfg = rax.getConfig(err);
            console.log(`Retry attempt #${cfg.currentRetryAttempt}`); // track current trial
        },
    },
    httpAgent: new http.Agent({keepAlive: true}),
    httpsAgent: new https.Agent({keepAlive: true}),
    jar: new tough.CookieJar()
});

axiosCookieJarSupport(axiosInstance);
axiosInstance.defaults.jar             = new tough.CookieJar();
axiosInstance.defaults.withCredentials = true;

async function getToken() {
    let result = await axiosInstance.request({
        method: 'GET',
        url: process.env.SOURCE_WIKI_BASE_URL + '/api.php',
        params: {
            action: 'query',
            meta: 'tokens',
            type: 'login',
            format: 'json',
        },
    }).catch(function (error) {
        logError(error);
    });

    return result.data.query.tokens.logintoken;
}

async function login(startAt, maxResults) {
    let token = await getToken();

    return axiosInstance.request({
        method: 'POST',
        url: process.env.SOURCE_WIKI_BASE_URL + '/api.php',
        data: querystring.stringify({
            lgtoken: token,
            action: 'login',
            format: 'json',
            lgname: process.env.SOURCE_WIKI_USER,
            lgpassword: process.env.SOURCE_WIKI_PASSWORD
        }),
    }).catch(function (error) {
        logError(error);
    });
}

async function getAllPagesByNamespace(startAt, maxResults, namespaceIndex) {
    return axiosInstance.request({
        method: 'GET',
        url: process.env.SOURCE_WIKI_BASE_URL + '/api.php',
        params: {
            action: 'query',
            list: 'allpages',
            format: 'json',
            apnamespace: namespaceIndex,
            aplimit: maxResults,
            apfrom: startAt
        },
    }).catch(function (error) {
        logError(error);
    });
}

async function getAllPages() {
    let proceedFrom = '';
    let allItems    = [];
    let count       = 0;
    let i           = 0;

    for (i = 0; i < PAGE_NAMESPACES_TO_SYNC.length; i++) {
        do {
            let allItemsPage = await getAllPagesByNamespace(proceedFrom, PAGE_SIZE, PAGE_NAMESPACES_TO_SYNC[i]);
            allItems         = allItems.concat(allItemsPage.data.query.allpages);
            if (typeof allItemsPage.data.continue === 'undefined') {
                break;
            }
            proceedFrom = allItemsPage.data.continue.apcontinue;
        } while (count++ < 1000);
    }


    return allItems;
}

async function getPageCategories(pageId, pageTitle) {
    let result = await axiosInstance.request({
        method: 'GET',
        url: process.env.SOURCE_WIKI_BASE_URL + '/api.php',
        params: {
            action: 'query',
            prop: 'categories',
            format: 'json',
            titles: pageTitle
        },
    }).catch(function (error) {
        logError(error);
    });

    let pageIdKey = (pageId).toString(10);
    if (typeof result.data.query.pages[pageIdKey] === 'undefined') {
        return [];
    }
    if (typeof result.data.query.pages[pageIdKey].categories === 'undefined') {
        return [];
    }

    return result.data.query.pages[pageIdKey].categories.map(function (item) {
        return item.title;
    });
}

async function getPageContent(pageId, pageTitle) {
    let result = await axiosInstance.request({
        method: 'GET',
        url: process.env.SOURCE_WIKI_BASE_URL + '/api.php',
        params: {
            action: 'parse',
            prop: 'wikitext',
            format: 'json',
            formatversion: 2,
            page: pageTitle
        },
    }).catch(function (error) {
        logError(error);
    });

    return result.data.parse.wikitext;
}

async function getPageImages(pageId, pageTitle) {
    let result = await axiosInstance.request({
        method: 'GET',
        url: process.env.SOURCE_WIKI_BASE_URL + '/api.php',
        params: {
            action: 'query',
            prop: 'images',
            format: 'json',
            titles: pageId + '|' + pageTitle,
            imlimit: 100,
        },
    }).catch(function (error) {
        logError('getPageImages', pageTitle, error.response.data);
    });


    let pageIdKey = getFirstNumericKey(result.data.query.pages);
    if (pageIdKey === false) {
        return [];
    }
    if (typeof result.data.query.pages[pageIdKey] === 'undefined') {
        return [];
    }

    if (typeof result.data.query.pages[pageIdKey].images === 'undefined') {
        return [];
    }

    for (let imageIndex in result.data.query.pages[pageIdKey].images) {
        let imageDataItem = result.data.query.pages[pageIdKey].images[imageIndex];
        let imageUrl      = await getImageURL(imageDataItem.title);

        result.data.query.pages[pageIdKey].images[imageIndex].url = imageUrl;
    }

    return result.data.query.pages[pageIdKey].images;
}

async function getImageURL(imageTitle) {
    let result = await axiosInstance.request({
        method: 'GET',
        url: process.env.SOURCE_WIKI_BASE_URL + '/api.php',
        params: { //api.php?action=query&titles=File:Test.jpg&prop=imageinfo&iilimit=50&iiend=2007-12-31T23:59:59Z&iiprop=timestamp|user|url
            action: 'query',
            prop: 'imageinfo',
            iiprop: 'timestamp|user|url',
            format: 'json',
            titles: imageTitle
        },
    }).catch(function (error) {
        logError(error);
    });

    let pageIdKey = getFirstNumericKey(result.data.query.pages);
    if (pageIdKey === false) {
        return [];
    }
    if (typeof result.data.query.pages[pageIdKey] === 'undefined') {
        return [];
    }

    if (typeof result.data.query.pages[pageIdKey].imageinfo === 'undefined') {
        return [];
    }

    return result.data.query.pages[pageIdKey].imageinfo[0].url;
}

async function wikiWikiToHtml(wikiText) {

    try {
        let result = await axiosInstance.request({
            method: 'POST',
            url: process.env.SOURCE_WIKI_BASE_URL + '/api.php',
            data: querystring.stringify({
                action: 'parse',
                format: 'json',
                text: wikiText,
                disabletoc: true,
                disableeditsection: true,
                wrapoutputclass: false,
            }),
        });

        return result.data.parse.text['*'];
    } catch (err) {
        // Handle Error Here
        console.error(err);
    }

}


async function getConfluencePage(title) {
    let result = await axiosInstance.request({
        method: 'GET',
        url: process.env.TARGET_CONFLUENCE_BASE_URL + '/wiki/rest/api/content',
        params: {
            type: 'page',
            spaceKey: process.env.TARGET_CONFLUENCE_SPACE_NAME,
            title: title,
            expand: 'body.storage'
        },
        auth: TARGET_AUTH,
    }).catch(function (error) {
        logError('getConfluencePage', title, error);
    });
    return result;
}

async function createConfluencePage(title, content, tags = []) {
    let labels = tags.map(function (item) {
        return {name: item};
    });

    let result = await axiosInstance.request({
        method: 'POST',
        url: process.env.TARGET_CONFLUENCE_BASE_URL + '/wiki/rest/api/content',
        data: {
            type: 'page',
            title: title,
            "space": {
                "key": process.env.TARGET_CONFLUENCE_SPACE_NAME
            },
            "status": "current",
            "body": {
                "storage": {
                    "value": content,
                    "representation": "storage"
                }
            },
            "metadata": {
                "labels": labels
            }
        },
        auth: TARGET_AUTH,
    }).catch(function (error) {
        logError('createConfluencePage', title, error.response.data);
    });
    return result;
}

async function deleteConfluencePage(pageId) {
    if (!isNumeric(pageId)) {
        return;
    }

    return await axiosInstance.request({
        method: 'DELETE',
        url: process.env.TARGET_CONFLUENCE_BASE_URL + '/wiki/rest/api/content/' + pageId,
        params: {
            "space": {
                "key": process.env.TARGET_CONFLUENCE_SPACE_NAME
            }
        },
        auth: TARGET_AUTH,
    }).catch(function (error) {
        logError(error.response);
    });
}

async function postConfluenceAttachment(pageId, remoteFileName, localFilePath) {
    /*
    curl -D- \
  -u <EMAIL>:<API_TOKEN> \
  -X POST \
  -H "X-Atlassian-Token: nocheck" \
  -F "file=@example.txt" \
  -F "minorEdit=true" \
  -F "comment=Example attachment comment" \
  http://<host>.atlassian.net/wiki/rest/api/content/857705024/child/attachment
     */

    let form = new FormData();
    // form.append('file', 'a,b,c', remoteFileName);
    form.append("file", fs.createReadStream(localFilePath), {
        filename: remoteFileName,
        knownLength: fs.statSync(localFilePath).size
    });
    form.append('comment', 'migrated from wiki.sitewards.net');

    return axiosInstance.put(process.env.TARGET_CONFLUENCE_BASE_URL + '/wiki/rest/api/content/' + pageId + '/child/attachment', form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        auth: TARGET_AUTH
    }).catch(error => {
        // Handle result…
        console.log(error);
    });
}

async function confluenceWikiToHtml(wikiText) {
    let result = await axios({
        method: 'POST',
        url: process.env.TARGET_CONFLUENCE_BASE_URL + '/wiki/rest/tinymce/1/wikixhtmlconverter',
        data: {
            "spaceKey": process.env.TARGET_CONFLUENCE_SPACE_NAME,
            "wiki": wikiText
        },
        auth: TARGET_AUTH,
    }).catch(function (error) {
        logError(error.response);
    });

    return result.data;
}

function isNumeric(str) {
    if (typeof str != "string") return false // we only process strings!
    return !isNaN(str) && // use type coercion to parse the _entirety_ of the string (`parseFloat` alone does not do this)...
        !isNaN(parseFloat(str)) // ...and ensure strings of whitespace fail
}

function getFirstNumericKey(wikiDataObject) {
    for (let key in wikiDataObject) {
        if (isNumeric(key)) {
            return key;
        }
    }
    return false;
}

function wikiCategoryToConfluenceTag(wikiCategoryTitle) {
    wikiCategoryTitle = wikiCategoryTitle.trim().replace(/ +/g, ' ').replace(': ', ':');
    return wikiCategoryTitle.replace(/[\s\:\.]/g, '-').toLowerCase();
}

function escapeWikiLinks(wikiText) {
    function replacer(match, p1, p2, p3, offset, string) {
        if (typeof p3 === 'undefined') {
            p3 = p1;
        }

        /* do we need todo something with [[User: ...]]? */

        if (p1.indexOf('Category') === 0) {
            return 'WIKI_CATEGORY_TOKEN_START' + p1 + 'WIKI_CATEGORY_TOKEN_END';
        }

        if (p1.indexOf('File') === 0) {
            return match.replace(/\[\[((\s?File\:([^\]]+?))\.([a-z0-9]+))(\|[^\]]+?)?\]\]/gi, 'WIKI_FILE_TOKEN_START$3.$4WIKI_FILE_TOKEN_END');
        }

        return 'WIKI_LINK_TOKEN_START' + p1 + '^^^' + p3 + 'WIKI_LINK_TOKEN_END';
    }

    return wikiText.replace(/\[\[ ?([^\]\|\n]+)(\|([^\]\n]+))?\]\]/g, replacer);
}

function renderWikiImages(htmlText) {
    function replacer(match, p1, p2, offset, string) {
        let resource = '<ri:attachment ri:filename="' + p1 + '.' + p2 + '" />';

        if (['png', 'jpeg', 'jpg', 'gif'].includes(p2)) {
            resource = '<ac:image ac:width="300px">' + resource + '</ac:image>';
        } else {
            resource = '<ac:link>' + resource + '</ac:link>';
        }

        return resource;
    }

    return htmlText.replace(/WIKI_FILE_TOKEN_START([^\]\n]+?)\.([^\.\]\n]+?)WIKI_FILE_TOKEN_END/gi, replacer);
}

function renderWikiLinks(htmlText) {
    function replacer(match, p1, p2, offset, string) {
        if (p1 === p2) {
            return '<ac:link><ri:page ri:content-title="' + p1 + '" /></ac:link>';
        }

        return '<ac:link><ri:page ri:content-title="' + p1 + '" /><ac:plain-text-link-body><![CDATA[' + p2 + ']]></ac:plain-text-link-body></ac:link>';
    }

    return htmlText.replace(
        /WIKI_LINK_TOKEN_START([^\^]+?)\^\^\^([^\^]+?)WIKI_LINK_TOKEN_END/g,
        replacer
    );
}

function removeBrokenHeaderIds(htmlText) {
    // remove cases like this:
    // <span class="mw-headline" id="Code_Review_.28a.k.a._WIKI_LINK_TOKEN_STARTPull-Request.5E.5E.5EPull-RequestWIKI_LINK_TOKEN_END.29">
    return htmlText.replace(
        /(<[^<>\/]+?id="[^\s<>]*?)WIKI_LINK_TOKEN_START([^\^\s"]+?)\.5E\.5E\.5E([^\^\s"]+?)WIKI_LINK_TOKEN_END([^"<>\s]*?")/g,
        '$1$2$4'
    );
}

function renderWikiCategories(htmlText) {
    function replacer(match, p1, offset, string) {
        let tagName = wikiCategoryToConfluenceTag(p1);

        return '<a className="aui-label-split-main" href="/wiki/label/' + process.env.TARGET_CONFLUENCE_SPACE_NAME + '/' + tagName + '" rel="tag">' + tagName + '</a>';
    }

    return htmlText.replace(/WIKI_CATEGORY_TOKEN_START([^<>\n]+?)WIKI_CATEGORY_TOKEN_END/g, replacer);
}

/**
 * the idea is simple, if somebody has opened the page for edit in confluence,
 * the whitespace will be removed and token will not look like it was inserted.
 * Confluence API does cleanup whitespaces, but it doesn't touch whitespace inside html attributes.
 *
 * Here is how token looks when inserted:
 *
 *     <p class="    PAGEEDITDETECTOR    "/>
 *
 * Here is how token looks after first page save:
 *
 *     '<p class="PAGEEDITDETECTOR"/>'
 */
function confluencePageIsUntouched(htmlText) {
    return htmlText.indexOf('"    PAGEEDITDETECTOR    "') !== -1;
}

async function pDownload(url, dest) {
    const downloader = new Downloader({
        url: url,
        directory: "/tmp",
        maxAttempts:3,//Default is 1.
        onError:function(error){//You can also hook into each failed attempt.
            console.log('Error from attempt ',error)
        }
    })

    try {
        await downloader.download();
    } catch (error) {//If all attempts fail, the last error is thrown.
        console.log('Final fail',error)
    }
}

async function syncWiki() {
    let result = await login();
    //console.log(result.data);

    console.log('Loading source pages...')
    let allSourcePages = await getAllPages();
    console.log("    loaded " + allSourcePages.length + " pages.");

    for (let sourcePageId in allSourcePages) {
        let sourcePage = allSourcePages[sourcePageId];

        console.log('Processing #' + sourcePage.pageid + ': ' + sourcePage.title);

        let confPageSearchResult = await getConfluencePage(sourcePage.title);
        if (confPageSearchResult.data.size > 0) {
            console.log('    Found matching confluence page', confPageSearchResult.data.results[0].id, confPageSearchResult.data.results[0].title);
            let confluencePageContents = confPageSearchResult.data.results[0].body.storage.value;
            if (!confluencePageIsUntouched(confluencePageContents)) {
                console.log('        page was modified after last import, skipping');
                continue;
            }

            if (!DELETE_EXISTING_PAGES) {
                continue;
            }
            // delete page
            console.log('        page seem to be untouched, deleting');
            await deleteConfluencePage(confPageSearchResult.data.results[0].id);
            console.log('            done');
        }

        let sourcePageCats     = await getPageCategories(sourcePage.pageid, sourcePage.title);
        sourcePageCats         = sourcePageCats.map(wikiCategoryToConfluenceTag)
        let sourcePageImages   = await getPageImages(sourcePage.pageid, sourcePage.title);
        let hasImages          = sourcePageImages.length > 0;
        let sourcePageContents = await getPageContent(sourcePage.pageid, sourcePage.title);
        sourcePageContents     = escapeWikiLinks(sourcePageContents);

        let htmlContents = await wikiWikiToHtml(sourcePageContents);
        htmlContents     = removeBrokenHeaderIds(htmlContents);
        htmlContents     = renderWikiImages(htmlContents);
        htmlContents     = renderWikiLinks(htmlContents);
        htmlContents     = renderWikiCategories(htmlContents);

        htmlContents += '<p class="    PAGEEDITDETECTOR    "/>';

        //console.log(htmlContents);

        let postPage         = await createConfluencePage(sourcePage.title, htmlContents, sourcePageCats);
        let confluencePageId = postPage.data.id;

        if (!hasImages) {
            console.log('    done');
            continue;
        }
        console.log('    transferring files');

        for (let fileIndex in sourcePageImages) {

            let fileItem = sourcePageImages[fileIndex];
            if (typeof fileItem.url === 'string') {
                console.log('        processing ' + fileItem.url);

                let fileBasename  = path.basename(fileItem.url);
                let localFilename = '/tmp/' + fileBasename;
                let localDirName = '/tmp/' + fileBasename;

                await pDownload(fileItem.url, localDirName);

                await postConfluenceAttachment(confluencePageId, fileItem.title.replace(/^File:/g, ''), localFilename);

                console.log('            uploaded');
            }

        }

        console.log('        done');
        console.log('    done');
    }
}

syncWiki();
