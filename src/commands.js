(async function () {
    chrome.commands.onCommand.addListener((command) => {
        switch (command) {
            case "open-devtools":
                openTab(settings.host, settings.port, true)
                if (settings.chromeNotifications) {
                    chrome.commands.getAll(async (commands) => {
                        const { shortcut, description } = commands[0]

                        chrome.notifications.create('', {
                            type: 'basic',
                            iconUrl: '/dist/icon/icon128.png',
                            title: chrome.i18n.getMessage('nimOwnsTheShortcut', [shortcut]),
                            message: description,
                            buttons: [
                                { title: chrome.i18n.getMessage('disableThisNotice') },
                                { title: chrome.i18n.getMessage('changeTheShortcut') }
                            ]
                        })
                    })
                }
                googleAnalytics.fireEvent('keyboardShortcut', { description: 'Keyboard Shortcut Used', action: 'open-devtools' })
                break
            case "open-tools":
                openWindow('repl')
                googleAnalytics.fireEvent('keyboardShortcut', { description: 'Keyboard Shortcut Used', action: 'open-tools' })
                break
        }
    })
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.commands = self.commands || {}))