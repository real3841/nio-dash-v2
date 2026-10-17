import AppKit

@MainActor
func makeMainMenu() -> NSMenu {
    let editMenu = NSMenu(title: "编辑")
    editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

    let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
    editItem.submenu = editMenu
    let menu = NSMenu()
    menu.addItem(editItem)
    return menu
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.mainMenu = makeMainMenu()
application.setActivationPolicy(.accessory)
application.run()
