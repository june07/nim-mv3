importScripts(
    './settings.js',
    './brakecode.js',
    './utilities.js',
    './analytics.js',
    './scripting.js',
    './devtoolsProtocolClient.js',
    '../node_modules/tweetnacl/nacl-fast.min.js',
    '../node_modules/tweetnacl-util/nacl-util.min.js',
    '../node_modules/amplitude-js/amplitude.umd.min.js',
    '../node_modules/async/dist/async.min.js',
);

amplitude.getInstance().init("0475f970e02a8182591c0491760d680a");

const VERSION = '0.0.0';
const INSTALL_URL = "https://blog.june07.com/nim-install/?utm_source=nim&utm_medium=chrome_extension&utm_campaign=extension_install&utm_content=1";
const UNINSTALL_URL = "https://bit.ly/2vUcRNn";
const SHORTNER_SERVICE_URL = 'https://shortnr.june07.com/api';
const NOTIFICATION_CHECK_INTERVAL = settings.ENV !== 'production' ? 60000 : 60 * 60000; // Check every hour
const NOTIFICATION_PUSH_INTERVAL = settings.ENV !== 'production' ? 60000 : 60 * 60000; // Push new notifications no more than 1 every hour if there is a queue.
const NOTIFICATION_LIFETIME = settings.ENV !== 'production' ? 3 * 60000 : 7 * 86400000;
const SOCKET_PATTERN = /((([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])):([0-9]+)/;
const devtoolsURL_Regex = /(devtools:\/\/|chrome-devtools:\/\/|https:\/\/chrome-devtools-frontend(\.appspot.com|\.june07.com)).*(inspector.html|js_app.html)/;
const UUID_Regex = new RegExp(/\b[0-9a-f]{8}\b-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-\b[0-9a-f]{12}\b/i);
const HIGH_WATER_MARK_MAX = 3;
const DRAIN_INTERVAL = 5000;

let cache = {
    timeouts: {},
    forceRemoveSession: {},
    highlighted: {},
    removed: {},
    messagePort: undefined
};
let state = {};

async function importForeignTabs() {
    return await queryForDevtoolTabs();
}
async function hydrateState() {
    /** this function will generally not be useful during testing because the session is restarted every time a reload is done
     *  So as a workaround use importForeignTabs() during development... might be useful to just keep period?!
     */
    state.sessions = await chrome.storage.session.get('sessions');
    if (settings.ENV !== 'production') {
        const foreignTabSessions = await importForeignTabs();
        await chrome.tabs.remove(foreignTabSessions.map((tab) => tab.id));
        foreignTabSessions.forEach((foreignTabSessions) => {
            openTab(foreignTabSessions.socket.host, foreignTabSessions.socket.port);
        })
    }
}
function resetInterval(func, timeout) {
    if (timeout) {
        clearTimeout(timeout);
    }
    return {
        func,
        interval: setInterval(func, timeout)
    }
}
(async function init() {
    await hydrateState();
    cache.checkInterval = resetInterval(() => {
        let home;
        Object.values(state.sessions).filter((session) => session.auto).map((session) => {
            const { host, port } = session.socket;

            if (host === settings.host && port === settings.port) {
                home = true;
            }
            openTab(host, port)
        });
        // if the home tab socket hasn't been added to the sessions yet
        if (!home && settings.auto) {
            openTab(settings.host, settings.port);
        }
        // failsafe interval of 60 seconds because the runaway problem can be real!!!
    }, settings.checkInterval || 60000);
    cache.drainInterval = setInterval(() => cache.highWaterMark > 0 && (cache.highWaterMark -= 1), DRAIN_INTERVAL);
})();

async function getInfo(host, port, remoteMetadata) {
    const url = remoteMetadata ? `` : `http://${host}:${port}/json`;
    const defaultOptions = {
        headers: {
            'Content-Type': 'application/json'
        }
    }
    const options = remoteMetadata ? {
        ...defaultOptions,
        headers: {
            ...defaultOptions.headers,
            'Authorization': 'Bearer ' + token
        },
    } : defaultOptions
    try {
        const response = await (await fetch(url, options)).json();
        // Will there ever be a reason to use an index other than 0? Not sure why an array is returned from Node.js?!
        return browserAgnosticFix(response[0]);
    } catch (error) {
        if (!error?.message?.match(/Failed to fetch/i)) {
            return new Error(error);
        }
    }
}
async function queryForDevtoolTabs(host, port) {
    const devtoolsBasePatterns = [
        `${settings.DEVTOOLS_SCHEME}*/*`,
        `https://chrome-devtools-frontend.june07.com/*:*`,
        `https://chrome-devtools-frontend.appspot.com/*:*`,
    ];
    const devtoolsSpecificPatterns = [
        `${settings.DEVTOOLS_SCHEME}*/*${host}:${port}*`,
        `${settings.DEVTOOLS_SCHEME}*/*${host}/ws/${port}*`,

        `https://chrome-devtools-frontend.june07.com/*${host}:${port}*`,
        `https://chrome-devtools-frontend.june07.com/*${host}/ws/${port}*`,

        `https://chrome-devtools-frontend.appspot.com/*${host}:${port}*`,
        `https://chrome-devtools-frontend.appspot.com/*${host}/ws/${port}*`
    ]
    const tabs = await chrome.tabs.query({
        url: !host || !port ? [ ...devtoolsBasePatterns, ...devtoolsSpecificPatterns ] : devtoolsSpecificPatterns
    });
    return tabs.map(tab => ({ ...tab, socket: { host, port } }));
}
async function openTab(host = 'localhost', port = 9229, remoteMetadata, manual) {
    let devtoolsURL;

    try {
        // settings.DEVTOOLS_SCHEME can be null on initial startup
        if ((!manual && cache[`openTab_${host}:${port}`]) || !settings?.DEVTOOLS_SCHEME) {
            return;
        }
        cache[`openTab_${manual ? '(manual)' : ''}${host}:${port}`] = Date.now();
        const tabs = await queryForDevtoolTabs(host, port);
        // close autoClose sessions if they are dead
        const sessionsWithClosedDebuggerProtocolSockets = tabs.map(tab => {
            const sessionForTab = state.sessions[tab.id];
            if (sessionForTab?.dtpSocket?.ws?.readyState === 3) {
                return sessionForTab;
            }
        }).filter((session) => session);
        await Promise.all(sessionsWithClosedDebuggerProtocolSockets.map(async (session) => {
                if (session.autoClose) {
                    return await chrome.tabs.remove(session.tabId);
                }
        }));
        // Highlighting when auto is set causes the browser to lose focus and grab control every checkInterval period.
        if (tabs.length) {
            const tabIndexes = tabs.map(tab => tab.index);
            
            // cache.highlighted so that highlighting is not interruptive as it only happens once per session instance
            if (manual || (!settings.auto && tabIndexes.filter((tabIndex) => !cache.highlighted[tabIndex])?.length)) {
                const highlight = chrome.tabs.highlight({ tabs: tabIndexes, windowId: tabs[0].windowId });
                tabIndexes.forEach((tabIndex) => cache.highlighted[tabIndex] = highlight);
            }
            return;
        }
        const info = await getInfo(host, port, remoteMetadata);
        if (!info) {
            return;
        }
        setDevtoolsURL(info);
        if (remoteMetadata) {
            devtoolsURL = info.devtoolsFrontendUrl.replace(/wss?=(.*)\//, remoteMetadata.wsProto + '=' + host + '/ws/' + port + '/');
            if (info.type === 'deno' || (info.webSocketDebuggerUrl && info.webSocketDebuggerUrl.match(/wss?:\/\/[^:]*:[0-9]+(\/ws\/)/))) {
                const id = info.webSocketDebuggerUrl.match(/wss?:\/\/[^:]*:[0-9]+(\/ws\/(.*))/)[2];
                devtoolsURL = devtoolsURL.replace(id, `${id}?runtime=deno`);
            }
        } else {
            devtoolsURL = info.devtoolsFrontendUrl.replace(/wss?=localhost/, 'ws=127.0.0.1');
            var inspectIP = devtoolsURL.match(SOCKET_PATTERN)[1];
            var inspectPORT = devtoolsURL.match(SOCKET_PATTERN)[5];
            devtoolsURL = devtoolsURL
                .replace(inspectIP + ":9229", host + ":" + port) // In the event that remote debugging is being used and the infoURL port (by default 80) is not forwarded take a chance and pick the default.
                .replace(inspectIP + ":" + inspectPORT, host + ":" + port) // A check for just the port change must be made.
        }
        // custom devtools
        if ((settings.localDevtools || settings.devtoolsCompat) && settings.localDevtoolsOptions[settings.localDevtoolsOptionsSelectedIndex].url.match(devtoolsURL_Regex)) {
            devtoolsURL = devtoolsURL.replace(devtoolsURL_Regex, settings.localDevtoolsOptions[settings.localDevtoolsOptionsSelectedIndex].url);
        }
        // legacy fix
        if (devtoolsURL.match(/chrome-devtools:\/\//)) {
            devtoolsURL = devtoolsURL.replace(/chrome-devtools:\/\//, 'devtools://');
        }
        await createTabOrWindow(getinfoURL(host, port), devtoolsURL, info, { host, port });
    } finally {
        const key = `openTab_${host}:${port}`;
        if (cache.timeouts[key]) {
            return;
        }
        /** 700 seems to be the sweet-spot for preventing rogue (i.e. multiple per devtools session) tabs.
         *  I thought initially that 501 should have worked but evidently it takes a while for the tab to
         *  show up during the query stage... 
         */
        cache.timeouts[key] = setTimeout(() => {
            if (cache[key]) {
                delete cache[key];
            };
            delete cache.timeouts[key];
        }, 700);
    }
}
function createTabOrWindow(infoURL, url, info, socket) {
    return new Promise(async function (resolve) {
        let webSocketDebuggerURL;
        if (infoURL.match(brakecode.PADS_HOST)) {
            webSocketDebuggerURL = url.match(brakecode.REGEXPS['INSPECTOR_WS_URL'])[0].replace('wss=', 'wss://');
        } else {
            webSocketDebuggerURL = info.webSocketDebuggerUrl;
        }
        const dtpSocketPromise = devtoolsProtocolClient.setSocket(info.id, webSocketDebuggerURL, {
            autoResume: settings.autoResumeInspectBrk,
            focusOnBreakpoint: settings.focusOnBreakpoint
        });
        if (settings.newWindow) {
            chrome.windows.getCurrent(async currentWindow => {
                const window = await chrome.windows.create({
                    url,
                    focused: settings.windowFocused,
                    type: (settings.panelWindowType) ? 'panel' : 'normal',
                    state: settings.windowStateMaximized ? chrome.windows.WindowState.MAXIMIZED : settings.windowFocused ? chrome.windows.WindowState.NORMAL : chrome.windows.WindowState.MINIMIZED
                });
                const tabId = window.tabs[0].id;
                updateTabUI(tabId);
                chrome.windows.update(currentWindow.id, { focused: true });
                const dtpSocket = await dtpSocketPromise;
                saveSession({ url, infoURL, tabId, info, dtpSocket, socket });
                resolve(window);
                amplitude.getInstance().logEvent('Program Event', { 'action': 'createWindow', 'detail': `focused: ${settings.windowFocused}` });
            });
        } else {
            const tab = await chrome.tabs.create({
                url,
                active: settings.tabActive,
            });
            updateTabUI(tab.id);
            const dtpSocket = await dtpSocketPromise;
            saveSession({ url, infoURL, tabId: tab.id, info, dtpSocket, socket });
            // group tabs
            if (settings.group && state.sessions.length > 0) {

            }
            resolve(tab);
            amplitude.getInstance().logEvent('Program Event', { 'action': 'createTab', 'detail': `focused: ${settings.tabActive}` });
        }
    }).catch((error) => {
        console.error(error);
    })
}
function updateTabUI(tabId) {
    chrome.scripting.executeScript(
        {
            target: {tabId: tabId, allFrames: true},
            func: scripting.updateTabUI,
            args: [ tabId ]
        },
        (injectionResults) => {
            if (!injectionResults) return;
            for (const frameResult of injectionResults) {
                console.log('Frame Title: ' + frameResult.result);
            }
    }); 
}
async function saveSession(params) {
    const { url, infoURL, tabId, info, dtpSocket, socket } = params;
    const existingSessions = Object.values(state.sessions).filter((session) => session.infoURL === infoURL);

    const session = {
        url,
        auto: existingSessions[0]?.auto || settings.auto,
        autoClose: existingSessions[0]?.autoClose || settings.autoClose,
        isWindow: existingSessions[0]?.isWindow || settings.isWindow,
        infoURL,
        tabId,
        info,
        dtpSocket,
        socket
    }
    state.sessions[tabId] = session;

    chrome.storage.session.set({ sessions: state.sessions });
    // if removeSessionOnTabRemoved is set to false then the session is saved until this point, now delete it. 
    existingSessions.map((session) => delete state.sessions[session.tabId]);
}
function getinfoURL(host, port) {
    if (host && host === brakecode?.PADS_HOST) {
        return `${brakecode.PADS_SERVER}/json/${port}`;
    }
    return `http://${host}:${port}/json`;
}
async function encryptMessage(message, publicKeyBase64Encoded) {
    const clientPrivateKey = nacl.randomBytes(32),
        publicKey = (publicKeyBase64Encoded !== undefined) ? nacl.util.decodeBase64(publicKeyBase64Encoded) : nacl.util.decodeBase64('cXFjuDdYNvsedzMWf1vSXbymQ7EgG8c40j/Nfj3a2VU='),
        nonce = crypto.getRandomValues(new Uint8Array(24)),
        keyPair = nacl.box.keyPair.fromSecretKey(clientPrivateKey);
    message = nacl.util.decodeUTF8(JSON.stringify(message));
    const encryptedMessage = nacl.box(message, nonce, publicKey, keyPair.secretKey);
    return nacl.util.encodeBase64(nonce) + ' ' + nacl.util.encodeBase64(keyPair.publicKey) + ' ' + nacl.util.encodeBase64(encryptedMessage);
}
async function getUserInfo() {
    const userInfo = await chrome.identity.getProfileUserInfo();
    const encryptedUserInfo = await encryptMessage(userInfo);
    chrome.storage.local.set({ userInfo: encryptedUserInfo });
    return encryptedUserInfo
}
function browserAgnosticFix(info) {
    if (info?.devtoolsFrontendUrlCompat) info.devtoolsFrontendUrl = info.devtoolsFrontendUrl.replace(/chrome-devtools:\/\//, 'devtools://');
    if (info?.devtoolsFrontendUrlCompat) info.devtoolsFrontendUrlCompat = info.devtoolsFrontendUrlCompat.replace(/chrome-devtools:\/\//, 'devtools://');
    return info;
}
function setDevtoolsURL(debuggerMetadata) {
    settings.localDevtoolsOptions[0].url = (settings.devtoolsCompat && debuggerMetadata.devtoolsFrontendUrlCompat) ? debuggerMetadata.devtoolsFrontendUrlCompat.split('?')[0] : debuggerMetadata.devtoolsFrontendUrl.split('?')[0];
    /** Deno is still using the legacy chrome-devtools:// scheme.  See https://github.com/denoland/deno/pull/7659 */
    settings.localDevtoolsOptions[0].url = settings.localDevtoolsOptions[0].url.replace(/chrome-devtools:\/\//, 'devtools://');
}
// This function can't be async... should according to the docs but ran into issues! Worked fine on the Vue side, but not in the popup window.
function messageHandler(request, sender, reply) {
    switch(request.command) {
        case 'openDevtools':
            const { host, port, remoteMetadata, manual } = request;
            if (cache[`${host}:${port}`]) return;
            try {
                cache[`${host}:${port}`] = Date.now();
                openTab(host, port, remoteMetadata, manual);
            } catch (error) {
                console.log(error);
            } finally {
                delete cache[`${host}:${port}`];
            }
            break;
        case 'getSettings': settings.get().then(reply); break;
        case 'getSessions': reply(state.sessions); break;
        case 'commit':
            const { store, obj, key, value } = request;
            let update;

            // pay attention to the fact that "sessions" below is different from the chrome "session" store!
            if (obj === 'sessions') {
                update = value ? { ...state[obj][key], ...value } : undefined;
                if (!update) {
                    // delete state[obj][key];
                    cache.forceRemoveSession[key] = true;
                    chrome.tabs.remove(key).then(() => {
                        async.until(
                            (cb) => cb(null, cache.removed[key]),
                            (next) => setTimeout(next, 500),
                            reply
                        );
                    }).catch(error => {
                        debugger
                    });
                } else {
                    state[obj][key] = update;
                    chrome.storage[store].set({ [obj]: state[obj] }).then(() => reply(update));
                }
            } else if (obj === 'settings') {
                update = { [key]: value };
                settings.update(update).then(() => reply(update));
            }
        break;
    }
    return true;
}

chrome.runtime.onInstalled.addListener(details => {
    if (details.reason === 'install') {
        chrome.tabs.create({ url: INSTALL_URL });
    }
    analytics.push({ event: 'install', onInstalledReason: details.reason });
});
chrome.runtime.onConnect.addListener((port) => {
    cache.messagePort = port
});
chrome.runtime.onMessage.addListener(messageHandler);
chrome.runtime.onMessageExternal.addListener(messageHandler);
chrome.runtime.onSuspend.addListener(() => {
    clearInterval(cache.checkInterval);
});
chrome.tabs.onCreated.addListener(function chromeTabsCreatedEvent(tab) {
    cache.highWaterMark = cache.highWaterMark ? cache.highWaterMark += 1 : 1;
    if (cache.highWaterMark > HIGH_WATER_MARK_MAX) {
        settings.auto = false;
    }
});
chrome.tabs.onRemoved.addListener(async function chromeTabsRemovedEvent(tabId) {
    if (!settings.removeSessionOnTabRemoved && !cache.forceRemoveSession[tabId]) return;
    delete cache.forceRemoveSession[tabId];
    delete state.sessions[tabId];
    await chrome.storage.session.set({ sessions: state.sessions });
    cache.removed[tabId] = Date.now();
    amplitude.getInstance().logEvent('Program Event', { 'action': 'onRemoved' });
});
chrome.storage.onChanged.addListener((changes, areaName) => {
    // send update if the sessions need to be re-read
    if (areaName.match(/session/) && cache?.messagePort?.postMessage) {
        cache.messagePort.postMessage({ command: 'update' });
    }
})