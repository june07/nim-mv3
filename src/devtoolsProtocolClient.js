(async function (devtoolsProtocolClient) {
    const userId = (await chrome.identity.getProfileUserInfo())?.id
    devtoolsProtocolClient.sockets = {}

    devtoolsProtocolClient.parseWebSocketUrl = (socketUrl) => socketUrl.match(/(wss?):\/\/(.*)\/(.*)$/)
    devtoolsProtocolClient.setSocket = (info, options) => {
        const socketUrl = info.remoteWebSocketDebuggerUrl ? info.remoteWebSocketDebuggerUrl() : info.webSocketDebuggerUrl
        const socket = devtoolsProtocolClient.parseWebSocketUrl(socketUrl)[2]
        const ws = devtoolsProtocolClient.getSocket(socketUrl)
        devtoolsProtocolClient.sockets[socket] = { messageIndex: 0, socketUrl, ws, socket }
        const promise = devtoolsProtocolClient.tasks(devtoolsProtocolClient.sockets[socket], options)
        return promise
    }
    devtoolsProtocolClient.getSocket = (socketUrl) => {
        // good info on why catching errors here doesn't work, https://stackoverflow.com/questions/31002592/javascript-doesnt-catch-error-in-websocket-instantiation
        return new WebSocket(socketUrl)
    }
    devtoolsProtocolClient.closeSocket = (dtpSocket) => {
        if (dtpSocket === undefined) return
        delete devtoolsProtocolClient.sockets[dtpSocket.socket]
        if (dtpSocket.ws.readyState !== WebSocket.CLOSED) dtpSocket.ws.close()
    }
    devtoolsProtocolClient.addEventListeners = async (dtpSocket, autoClose, tabId) => {
        googleAnalytics.fireEvent('debuggerSessionStart', {
            socketUrl: dtpSocket.socketUrl,
            userId,
            tabId
        })
        dtpSocket.ws.addEventListener('close', (event) => {
            googleAnalytics.fireEvent('debuggerSessionEnd', {
                socketUrl: dtpSocket.socketUrl,
                userId,
                tabId
            })
            if (settings.debugVerbosity >= 1) console.log('ws closed: ', event)
            devtoolsProtocolClient.closeSocket(devtoolsProtocolClient.sockets[dtpSocket.socket])
            /** First check to see if the tab was removed by the user in which case there should be a cache.removed entry from sw.js
             *  Also make sure the socket is part of a local session as there's an issue with false close events coming from remote
             *  sessions!
             */
            if (autoClose && !cache.removed[tabId] && !utils.isRemoteSocket(dtpSocket.socket)) {
                const log = `protocol client removing tabId: ${tabId}... `
                chrome.tabs.remove(tabId)
                    .then(() => console.log(`${log} removed.`))
                    .catch(error => {
                        if (!error.message.match(/No tab with id:/)) {
                            console.error(error)
                        } else if (error.message.match(/No tab with id:/)) {
                            console.log(`${log} ${error}`)
                        }
                    })
            }
            //delete cache.tabs[dtpSocket.socket]?.promise
            delete cache.tabs[dtpSocket.socket]
        })
        dtpSocket.ws.addEventListener('message', (event) => {
            const data = JSON.parse(event.data)
            const { method, params } = data

            if (/Debugger\.(paused|resumed)/.test(method)) {
                let details = { method, timestamp: Date.now() }

                if (method === 'Debugger.paused') {
                    details = { ...details, 'params_callFrames_0__location': JSON.stringify(params.callFrames[0]?.location) }
                    googleAnalytics.fireEvent('debuggerPaused', { ...details, userId })
                } else if (method === 'Debugger.resumed') {
                    googleAnalytics.fireEvent('debuggerResumed', { ...details, userId })
                }
            }
        })
        async function logReadyState() {
            try {
                const url = `http://${dtpSocket.socket}/json`
                const response = await fetch(url)
                if (settings.debugVerbosity >= 9) {
                    console.log(response)
                }
            } catch (error) {
                if (settings.debugVerbosity >= 9) {
                    console.error(error)
                }
                dtpSocket.ws.close()
                clearInterval(interval)
            }
        }
        // not sure this is needed anymore, seems to work fine now?!  https://github.com/june07/nimv3/commit/5ee06e141e2dc6b33f08e394b89739152f723d50
        // UPDATE 7/23/24... IT IS IN FACT NEEDED. Breaks autoClose without it
        const interval = setInterval(logReadyState, 1000)
        await async.until(
            (cb) => cb(null, dtpSocket.ws.readyState === WebSocket.OPEN),
            (next) => setTimeout(next, 500)
        )
        dtpSocket.ws.send('{"id": 1, "method": "Debugger.enable"}')
    }
    devtoolsProtocolClient.tasks = (socket, options) => {
        const t1 = new Promise(resolve => {
            const autoResume = options && options.autoResume ? options.autoResume : false
            if (autoResume) {
                devtoolsProtocolClient.autoResumeInspectBrk(socket)
                    .then(socket => {
                        resolve(socket)
                    })
            } else {
                resolve(socket)
            }
        })
        const t2 = new Promise(resolve => {
            const focusOnBreakpoint = options && options.focusOnBreakpoint ? options.focusOnBreakpoint : false
            if (focusOnBreakpoint) devtoolsProtocolClient.focusOnBreakpoint(socket)
            resolve(socket)
        })
        return Promise.all([t1, t2])
            .then(() => {
                return Promise.resolve(socket)
            })
    }
    devtoolsProtocolClient.autoResumeInspectBrk = (socket) => {
        const parsedData = {}

        socket.ws.addEventListener('message', event => {
            const parsed = JSON.parse(event.data)
            switch (parsed.method) {
                case 'Debugger.paused':
                    if (!devtoolsProtocolClient.sockets[socket.socket].autoResumedOnce) {
                        socket.ws.send(JSON.stringify({ id: 667 + socket.messageIndex++, method: 'Debugger.resume' }))
                        console.log(`Auto resuming debugger from initial 'inspect-brk' state.`)
                        devtoolsProtocolClient.sockets[socket.socket].autoResumedOnce = true
                    }
                    break
                case 'Debugger.scriptParsed':
                    if (parsed.url && parsed.url.indexOf('helloworld2.js')) {
                        parsedData.scriptId = parsed.params.scriptId
                    }
                    break
            }
            if (settings.debugVerbosity >= 1) console.log(event)
        })
        return new Promise(resolve => {
            socket.ws.onopen = event => {
                if (settings.debugVerbosity >= 1) console.log(event)
                socket.ws.send(JSON.stringify({ id: 667 + socket.messageIndex++, method: 'Debugger.enable' }))
                //socket.ws.send(JSON.stringify({ id: 667+socket.messageIndex++, method: 'Debugger.resume' }));
                //if (settings.debugVerbosity >= 5) console.log(`DevToolsProtocolClient issued protocol command: Debugger.resume`);
            }
            resolve(socket)
        })
    }
    devtoolsProtocolClient.focusOnBreakpoint = (socket) => {
        socket.ws.addEventListener('message', event => {
            const parsed = JSON.parse(event.data)
            switch (parsed.method) {
                case 'Debugger.paused':
                    var ws = event.currentTarget.url.split('ws://')[1]
                    var session = Object.values(state.sessions).find(session => session.url.includes(ws))
                    if (session === undefined) return
                    if (session.newWindow) {
                        chrome.windows.update(session.windowId, { focused: true }, window => {
                            if (settings.debugVerbosity >= 4) console.log(`focusOnBreakpoint(): window: ${window.id}`)
                        })
                    } else {
                        chrome.tabs.update(session.tabId, { active: true }, tab => {
                            chrome.windows.update(tab.windowId, { focused: true }, window => {
                                if (settings.debugVerbosity >= 4) console.log(`focusOnBreakpoint(): window: ${window.id} tab: ${tab.id}`)
                            })
                        })
                    }
                    break
            }
            if (settings.debugVerbosity >= 1) console.log(event)
        })
    }
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.devtoolsProtocolClient = self.devtoolsProtocolClient || {}))