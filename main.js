const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os'); // Başlat menüsünü bulmak için eklendi
const si = require('systeminformation'); 

let win;
let tray = null;
let isQuitting = false;
let cachedDisks = null;

const DATA_PATH = path.join(app.getPath('userData'), 'shortcuts.json');



// 1. Önce yolu tanımla (DATA_PATH'in hemen altına ekleyebilirsin)
//const USER_ICONS_PATH = path.join(app.getPath('userData'), 'MyIcons');
//const USER_ICONS_PATH = path.join(os.homedir(), 'Documents', 'GFEM_Launcher_Icons');
const USER_ICONS_PATH = path.join(app.getPath('documents'), 'GFEM_Launcher_Icons');

// 2. Klasör yoksa oluştur (Hata almamak için şart)
    if (!fs.existsSync(USER_ICONS_PATH)) {       
        fs.mkdirSync(USER_ICONS_PATH);
}

// 1. Uygulamanın tek bir örneği mi kontrol et
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Eğer zaten bir örnek açıksa, bu yeni açılmaya çalışanı hemen kapat
  app.quit();
} else {
  // Eğer ilk kez açılıyorsa, ikinci bir kez açılmaya çalışıldığında ne yapacağını söyle:
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (win) {
      if (win.isMinimized()) win.restore(); // Simge durumundaysa geri getir
      if (!win.isVisible()) win.show(); // Gizliyse (Tray) göster
      win.focus(); // Pencereye odaklan
    }
  });
  }
function createWindow () {
    win = new BrowserWindow({
        width: 1200, height: 800,
        alwaysOnTop: true,
        icon: path.join(__dirname, 'assets', 'icons', 'tray-icon.png'),
	    minimizable: true,   // Küçültme butonunu zorla aktif eder
        maximizable: true,   // Büyütme butonunu zorla aktif eder
        resizable: true,     // Pencere boyutlandırmayı açar
        webPreferences: { nodeIntegration: true, contextIsolation: false}
    });
    win.setMenuBarVisibility(false);
    win.loadFile('index.html');
    win.on('close', function (event) { if (!isQuitting) { event.preventDefault(); win.hide(); } return false; });
}

app.setAppUserModelId(process.execPath);
async function scanDisksBackground() {
    try {
        const diskData = await si.fsSize();
        const localDisks = diskData.filter(d => d.type !== 'CD-ROM' && d.type !== 'Network');
        cachedDisks = localDisks.map(disk => ({ DeviceID: disk.mount.replace('\\', ''), Size: disk.size, FreeSpace: disk.size - disk.used }));
    } catch (e) { console.error("Disk okuma hatası", e); cachedDisks = []; }
}

app.whenReady().then(() => {
    createWindow();
    scanDisksBackground();

    ipcMain.handle('get-disks', async () => {
        // Artık "cebimde var mı" diye bakmıyor. 
        // Her istek geldiğinde Windows'a SIFIRDAN güncel durumu soruyor!
        await scanDisksBackground(); 
        return cachedDisks;
    });

    ipcMain.handle('select-folder', async () => {
        const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Select Folder to Add' });
        return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('select-file', async () => {
        const result = await dialog.showOpenDialog({ properties: ['openFile'] });
        return result.canceled ? null : result.filePaths[0];
    });

    // UYGULAMA İKONU SEÇME PENCERESİ
ipcMain.handle('select-icon', async () => {
    const result = await dialog.showOpenDialog({
        defaultPath: USER_ICONS_PATH, 
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'ico'] }]
    });

    if (result.canceled) return null;

    const sourcePath = result.filePaths[0];
    
    // 1. Seçilen dosyanın klasörünü ve bizim hedef klasörü karşılaştırmak için düzenliyoruz
    const sourceDir = path.normalize(path.dirname(sourcePath));
    const targetDir = path.normalize(USER_ICONS_PATH);

    // 2. KONTROL: Eğer seçilen resim zaten bizim ikon klasöründeyse kopyalama YAPMA
    if (sourceDir === targetDir) {
        return sourcePath.replace(/\\/g, '/');
    }

    // 3. Eğer resim DIŞARIDAN (Masaüstü, İndirilenler vb.) seçildiyse KOPYALA
    const fileName = `icon_${Date.now()}${path.extname(sourcePath)}`;
    const destPath = path.join(USER_ICONS_PATH, fileName);

    fs.copyFileSync(sourcePath, destPath);

    return destPath.replace(/\\/g, '/');
});

    // BAŞLAT MENÜSÜ UYGULAMALARINI TARAMA MOTORU
    ipcMain.handle('get-installed-apps', () => {
        const globalStartMenu = path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
        const userStartMenu = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
        let apps = [];
        function findLinks(dir) {
            if (!fs.existsSync(dir)) return;
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file); const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) findLinks(fullPath);
                else if (file.endsWith('.lnk')) {
                    const name = file.replace('.lnk', '');
                    if (!name.toLowerCase().includes('uninstall') && !name.toLowerCase().includes('help')) apps.push({ name: name, path: fullPath });
                }
            }
        }
        findLinks(globalStartMenu); findLinks(userStartMenu);
        return apps.sort((a, b) => a.name.localeCompare(b.name));
    });

    ipcMain.handle('save-shortcuts', async (event, shortcuts) => { fs.writeFileSync(DATA_PATH, JSON.stringify(shortcuts)); return true; });
    ipcMain.handle('load-shortcuts', async () => { if (fs.existsSync(DATA_PATH)) return JSON.parse(fs.readFileSync(DATA_PATH)); return []; });
// YEDEK GERİ YÜKLEME MOTORU
    ipcMain.handle('restore-backup', async () => {
        // Kullanıcıya dosya seçtir
        const result = await dialog.showOpenDialog(win, {
            properties: ['openFile'],
            title: 'Select Backup File (.json)',
            filters: [{ name: 'JSON Files', extensions: ['json'] }]
        });
        
        if (result.canceled) return { success: false }; // Kullanıcı iptal ederse bir şey yapma

        try {
            const filePath = result.filePaths[0];
            const fileData = fs.readFileSync(filePath, 'utf-8'); // Dosyayı oku
            const parsedData = JSON.parse(fileData); // JSON formatına çevir
            
            // Okunan yeni veriyi doğrudan sistemin ana kayıt dosyasına (shortcuts.json) yazıp üzerine kaydet
            fs.writeFileSync(DATA_PATH, JSON.stringify(parsedData)); 
            
            return { success: true, data: parsedData }; // Başarılıysa verileri ön yüze yolla
        } catch (err) {
            console.error("Geri yükleme hatası:", err);
            return { success: false, error: err.message };
        }
    });

    const iconPath = path.join(__dirname, 'assets', 'icons', 'tray-icon.png');
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([{ label: 'Show', click: function() { win.show(); } }, { label: 'Exit', click: function() { isQuitting = true; app.quit(); }}]);
    tray.setToolTip('GFEM_Launcher'); tray.setContextMenu(contextMenu);
    tray.on('double-click', () => { win.show(); });
});

ipcMain.on('quit-app', () => { isQuitting = true; app.quit(); });

// SAĞ TIK MENÜSÜ GÜNCELLEMESİ (İkon Değiştirme Eklendi)
ipcMain.on('show-context-menu', (event, data) => {
    const { id, type, currentGroups, lang } = data; // HTML'den gelen 'lang' bilgisini yakaladık!
    
    // Dile göre kelimeleri belirliyoruz
    const isTr = lang === 'tr';
    const txtRename = isTr ? 'Yeniden Adlandır' : 'Rename';
    const txtMoveTo = isTr ? 'Şu Gruba Taşı...' : 'Move to...';
    const txtNewGroup = isTr ? '+ Yeni Grup Oluştur' : '+ Create New Group';
    const txtChangeIcon = isTr ? 'İkonu Değiştir' : 'Change Icon';
    const txtDelete = isTr ? 'Sil' : 'Delete';

    const template = [
        {
            label: txtRename,
            click: () => { event.sender.send('trigger-rename-modal', id); }
        },
        {
            label: txtMoveTo,
            submenu: [
                ...currentGroups.map(group => ({
                    label: group,
                    click: () => { event.sender.send('context-menu-move', { id, newGroup: group }); }
                })),
                { type: 'separator' },
                {
                    label: txtNewGroup,
                    click: () => { event.sender.send('context-menu-move-new', id); }
                }
            ]
        },
        { type: 'separator' },
        {
            label: txtChangeIcon,
            click: () => { event.sender.send('trigger-change-icon', id); }
        },
        { type: 'separator' },
        {
            label: txtDelete,
            click: () => { event.sender.send('context-menu-delete', id); }
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    menu.popup(BrowserWindow.fromWebContents(event.sender));
});

// AÇILIŞTA BAŞLATMA AYARI (Windows Registry'e yazar/siler)
ipcMain.on('toggle-autostart', (event, isEnabled) => {
    app.setLoginItemSettings({
        openAtLogin: isEnabled,
        path: app.getPath('exe') // Uygulamanın kurulu olduğu yeri otomatik bulur
    });
});

// Arayüzden gelen "sağ tıklandı, aşağı in" emrini dinler
ipcMain.on('minimize-app', () => {
        if (win) win.minimize();
});

// UYGULAMAYI YENİDEN BAŞLATMA (Fabrika ayarları sıfırlanınca tetiklenir)
ipcMain.on('relaunch-app', () => {
    app.relaunch();
    app.quit();
});

// İKON KLASÖRÜNÜ AÇMA KOMUTU
ipcMain.on('open-icon-folder', () => {
    shell.openPath(USER_ICONS_PATH);
});
