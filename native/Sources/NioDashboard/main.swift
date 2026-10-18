import AppKit

@MainActor
func makeMainMenu() -> NSMenu {
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "隐藏蔚来车辆看板", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "退出蔚来车辆看板", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

    let windowMenu = NSMenu(title: "窗口")
    windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

    let editMenu = NSMenu(title: "编辑")
    editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

    let menu = NSMenu()
    for (title, submenu) in [("蔚来车辆看板", appMenu), ("编辑", editMenu), ("窗口", windowMenu)] {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = submenu
        menu.addItem(item)
    }
    NSApplication.shared.windowsMenu = windowMenu
    return menu
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.mainMenu = makeMainMenu()
application.setActivationPolicy(.accessory)
application.run()
