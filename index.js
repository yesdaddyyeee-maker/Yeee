import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import gplay from 'google-play-scraper';
import cloudscraper from 'cloudscraper';
import axios from 'axios';
import AdmZip from 'adm-zip';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = pino({ level: 'silent' });

const userSessions = new Map();
const BOT_NAME = 'AppOmar';
const BOT_LOGO = 'https://i.imgur.com/appomar.jpg';
const TEMP_DIR = path.join(__dirname, '.temp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let pairingCodeRequested = false;
let waitingForPairing = false;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    printQRInTerminal: false,
    browser: ['Windows', 'Chrome', '10.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;
      
      if (shouldReconnect && !waitingForPairing) {
        console.log('🔄 إعادة الاتصال...');
        setTimeout(connectToWhatsApp, 5000);
      } else if (waitingForPairing) {
        console.log('⏸️  في انتظار إدخال كود الاقتران...');
      } else {
        console.log('❌ تم تسجيل الخروج');
        pairingCodeRequested = false;
      }
    } else if (connection === 'open') {
      console.log('✅ تم الاتصال بنجاح!');
      console.log(`🤖 بوت ${BOT_NAME} جاهز للعمل!\n`);
      pairingCodeRequested = false;
      waitingForPairing = false;
    }
  });

  if (!state.creds.registered && !pairingCodeRequested) {
    pairingCodeRequested = true;
    waitingForPairing = true;
    
    let phoneNumber = process.env.PHONE_NUMBER;
    
    if (!phoneNumber) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('⚠️  لم يتم تعيين رقم الهاتف');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('يرجى تعيين متغير البيئة PHONE_NUMBER');
      console.log('مثال: PHONE_NUMBER=966501234567');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      phoneNumber = await new Promise((resolve) => {
        rl.question('أو أدخل رقم الهاتف الآن (مع رمز الدولة): ', (number) => {
          resolve(number.replace(/[^0-9]/g, ''));
        });
      });
    } else {
      phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
      console.log(`📱 رقم الهاتف: ${phoneNumber}`);
    }
    
    if (!phoneNumber) {
      console.error('❌ رقم الهاتف مطلوب');
      pairingCodeRequested = false;
      waitingForPairing = false;
      process.exit(1);
    }
    
    setTimeout(async () => {
      try {
        console.log('\n📲 جاري طلب كود الاقتران...\n');
        const code = await sock.requestPairingCode(phoneNumber);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
        console.log(`           🔐 كود الربط: ${code}`);
        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
        console.log('⚡ أدخل الكود فوراً في WhatsApp:');
        console.log('   1. افتح WhatsApp على هاتفك الآن');
        console.log('   2. الإعدادات > الأجهزة المرتبطة');
        console.log('   3. ربط جهاز');
        console.log(`   4. أدخل: ${code}`);
        console.log('');
        console.log('⚠️  IMPORTANT: أدخل الكود خلال 20 ثانية!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      } catch (error) {
        console.error('❌ خطأ في طلب كود الربط:', error.message);
        console.log('\n💡 إذا استمرت المشكلة:');
        console.log('   - احذف مجلد auth_info_baileys');
        console.log('   - أعد تشغيل البوت');
        console.log('   - أدخل الكود بسرعة كبيرة\n');
        pairingCodeRequested = false;
        waitingForPairing = false;
      }
    }, 2000);
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    try {
      await handleMessage(sock, msg);
    } catch (error) {
    }
  });

  return sock;
}

async function handleMessage(sock, msg) {
  const messageType = Object.keys(msg.message)[0];
  let text = '';

  if (messageType === 'conversation') {
    text = msg.message.conversation;
  } else if (messageType === 'extendedTextMessage') {
    text = msg.message.extendedTextMessage.text;
  }

  if (!text || text.trim().length === 0) return;

  const chatId = msg.key.remoteJid;
  const userSession = userSessions.get(chatId);

  if (userSession && userSession.waitingForNumber) {
    const selectedNumber = parseInt(text.trim());
    
    if (!isNaN(selectedNumber) && selectedNumber >= 1 && selectedNumber <= userSession.apps.length) {
      const selectedApp = userSession.apps[selectedNumber - 1];
      userSessions.delete(chatId);
      
      await sendWithContext(sock, chatId, { 
        text: 'جاري جلب تفاصيل التطبيق... ⏳' 
      });

      try {
        const appDetails = await gplay.app({ 
          appId: selectedApp.appId,
          lang: 'ar',
          country: 'sa'
        });

        await sendAppWithDownload(sock, chatId, appDetails);
      } catch (error) {
        await sendWithContext(sock, chatId, { 
          text: 'حدث خطأ أثناء جلب تفاصيل التطبيق.' 
        });
      }
    } else {
      await sendWithContext(sock, chatId, { 
        text: 'الرجاء إرسال رقم صحيح من القائمة.' 
      });
    }
    return;
  }

  await sendWithContext(sock, chatId, { 
    text: '🔄 جاري البحث في متجر Google Play...' 
  });

  try {
    const results = await gplay.search({
      term: text.trim(),
      num: 10,
      lang: 'ar',
      country: 'sa'
    });

    if (results.length === 0) {
      await sendWithContext(sock, chatId, { 
        text: 'لم يتم العثور على نتائج. جرب كلمة بحث أخرى.' 
      });
      return;
    }

    let listMessage = `╔═══ 📱 نتائج البحث ═══╗\n\n`;
    listMessage += `🔎 تم العثور على ${results.length} تطبيق\n`;
    listMessage += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    results.forEach((app, index) => {
      const star = '⭐'.repeat(Math.round(app.score || 0));
      listMessage += `${index + 1}. *${app.title}*\n`;
      listMessage += `   📦 ${app.appId}\n`;
      listMessage += `   ${star} ${app.score ? app.score.toFixed(1) : 'N/A'}\n`;
      listMessage += `   💾 ${app.size || 'غير متوفر'}\n`;
      listMessage += `━━━━━━━━━━━━━━━━━━━━\n`;
    });
    
    listMessage += `\n✍️ *أرسل رقم التطبيق للتحميل*\n`;
    listMessage += `⏱️ سينتهي هذا الطلب خلال 5 دقائق`;

    await sendWithContext(sock, chatId, { text: listMessage });

    userSessions.set(chatId, {
      apps: results,
      waitingForNumber: true,
      timestamp: Date.now()
    });

    setTimeout(() => {
      const session = userSessions.get(chatId);
      if (session && session.timestamp === userSessions.get(chatId)?.timestamp) {
        userSessions.delete(chatId);
      }
    }, 300000);

  } catch (error) {
    await sendWithContext(sock, chatId, { 
      text: 'حدث خطأ أثناء البحث. حاول مرة أخرى.' 
    });
  }
}

async function sendAppWithDownload(sock, chatId, app) {
  try {
    const infoMessage = `╔══════════════════════╗
    📱 *معلومات التطبيق*
╚══════════════════════╝

🎯 *${app.title}*

📝 *الوصف:*
${app.summary || app.description?.substring(0, 250) || 'غير متوفر'}...

━━━━━━━━━━━━━━━━━━━━

⭐ *التقييم:* ${'⭐'.repeat(Math.round(app.score || 0))} ${app.score ? app.score.toFixed(1) : 'N/A'}/5
📊 *التقييمات:* ${formatNumber(app.ratings || 0)}
⬇️ *التحميلات:* ${app.installs || 'غير متوفر'}
🏢 *المطور:* ${app.developer || 'غير متوفر'}
💾 *الحجم:* ${app.size || 'غير متوفر'}
🆕 *آخر تحديث:* ${app.updated || 'غير متوفر'}
💰 *السعر:* ${app.free ? '🎉 مجاني' : (app.price || 'غير متوفر')}

━━━━━━━━━━━━━━━━━━━━

🔄 *جاري تحضير التطبيق...*`.trim();

    if (app.icon) {
      try {
        const iconResponse = await axios.get(app.icon, { 
          responseType: 'arraybuffer',
          timeout: 15000 
        });
        
        await sock.sendMessage(chatId, {
          image: Buffer.from(iconResponse.data),
          caption: infoMessage,
          contextInfo: {
            externalAdReply: {
              title: app.title,
              body: `${app.developer} - ${app.size || 'حجم غير معروف'}`,
              thumbnailUrl: app.icon,
              sourceUrl: 'https://instagram.com/omarxarafp',
              mediaType: 1,
              renderLargerThumbnail: true
            }
          }
        });
      } catch (iconError) {
        await sendWithContext(sock, chatId, { text: infoMessage });
      }
    } else {
      await sendWithContext(sock, chatId, { text: infoMessage });
    }

    const packageName = app.appId;
    
    await sendWithContext(sock, chatId, { 
      text: '🔍 جاري البحث عن أفضل سيرفر للتحميل...\n\n⏳ لحظات' 
    });

    const downloadInfo = await findBestDownloadSource(packageName);

    if (!downloadInfo || !downloadInfo.url) {
      await sendWithContext(sock, chatId, { 
        text: '❌ عذراً، لم نتمكن من إيجاد رابط تحميل للتطبيق.\n\n💡 جرب تطبيقاً آخر أو حاول لاحقاً' 
      });
      return;
    }

    const progressEmojis = ['⚪', '🔵', '🟢', '🟡', '🟠', '🔴', '🟣'];
    const progressMsg = await sendWithContext(sock, chatId, { 
      text: `${progressEmojis[0]} جاري التحميل... 0%\n\n📦 النوع: ${downloadInfo.type}\n💾 الحجم: ${downloadInfo.size || 'غير معروف'}` 
    });

    try {
      const tempFile = path.join(TEMP_DIR, `${Date.now()}_${sanitizeFilename(app.title)}.${downloadInfo.type}`);
      
      let lastProgress = 0;
      const result = await downloadFileWithProgress(downloadInfo.url, tempFile, async (progress) => {
        if (progress - lastProgress >= 15 || progress > 95) {
          lastProgress = progress;
          const emoji = progressEmojis[Math.floor(progress / 100 * (progressEmojis.length - 1))];
          const progressBar = '▓'.repeat(Math.floor(progress / 5)) + '░'.repeat(20 - Math.floor(progress / 5));
          
          try {
            await sock.sendMessage(chatId, {
              text: `${emoji} جاري التحميل... ${progress}%\n\n${progressBar}\n\n📦 ${downloadInfo.type.toUpperCase()}`,
              edit: progressMsg?.key
            });
          } catch (e) {}
        }
      });

      if (!result || !fs.existsSync(tempFile)) {
        await sendWithContext(sock, chatId, { 
          text: '❌ فشل تحميل التطبيق.\n\n🔄 حاول مرة أخرى لاحقاً' 
        });
        return;
      }

      const fileStats = fs.statSync(tempFile);
      const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);

      await sendWithContext(sock, chatId, { 
        text: `✅ اكتمل التحميل!\n\n📤 جاري الرفع... (${fileSizeMB} MB)\n\n⏳ الرجاء الانتظار` 
      });

      if (downloadInfo.type === 'xapk' || downloadInfo.type === 'apks') {
        await handleCompressedApp(sock, chatId, app, tempFile, downloadInfo.type);
      } else {
        const buffer = fs.readFileSync(tempFile);
        await sock.sendMessage(chatId, {
          document: buffer,
          mimetype: getMimeType(downloadInfo.type),
          fileName: `${sanitizeFilename(app.title)}.${downloadInfo.type}`,
          caption: `✅ *${app.title}*\n\n📦 الحجم: ${fileSizeMB} MB\n🎯 النوع: ${downloadInfo.type.toUpperCase()}\n\n💚 تم التحميل بنجاح!`,
          contextInfo: {
            externalAdReply: {
              title: app.title,
              body: `${BOT_NAME} - تحميل ناجح ✅`,
              thumbnailUrl: app.icon,
              sourceUrl: 'https://instagram.com/omarxarafp',
              mediaType: 1,
              renderLargerThumbnail: true
            }
          }
        });
      }

      try {
        fs.unlinkSync(tempFile);
      } catch (e) {}

      await sendWithContext(sock, chatId, { 
        text: `━━━━━━━━━━━━━━━━━━━━\n\n📱 *تابعنا على انستجرام*\n🔗 instagram.com/omarxarafp\n\n💎 شكراً لاستخدامك ${BOT_NAME}\n\n━━━━━━━━━━━━━━━━━━━━` 
      });

    } catch (uploadError) {
      await sendWithContext(sock, chatId, { 
        text: '❌ حدث خطأ أثناء رفع الملف.\n\n💡 الملف قد يكون كبيراً جداً' 
      });
    }

  } catch (error) {
    await sendWithContext(sock, chatId, { 
      text: '❌ حدث خطأ أثناء معالجة التطبيق.\n\n🔄 حاول مرة أخرى' 
    });
  }
}

async function sendWithContext(sock, chatId, options) {
  try {
    if (!options.contextInfo) {
      options.contextInfo = {
        externalAdReply: {
          title: BOT_NAME,
          body: 'بوت تحميل التطبيقات',
          thumbnailUrl: BOT_LOGO,
          sourceUrl: 'https://instagram.com/omarxarafp',
          mediaType: 1
        }
      };
    }
    const sentMsg = await sock.sendMessage(chatId, options);
    return sentMsg;
  } catch (error) {
    delete options.contextInfo;
    const sentMsg = await sock.sendMessage(chatId, options);
    return sentMsg;
  }
}

async function findBestDownloadSource(packageName) {
  const sources = [
    {
      name: 'APKPure XAPK',
      url: `https://d.apkpure.com/b/XAPK/${packageName}?version=latest`,
      type: 'xapk'
    },
    {
      name: 'APKPure APK',
      url: `https://d.apkpure.com/b/APK/${packageName}?version=latest`,
      type: 'apk'
    },
    {
      name: 'APKCombo APKS',
      url: `https://apkcombo.com/downloader/download?package=${packageName}&type=apks`,
      type: 'apks'
    }
  ];

  for (const source of sources) {
    try {
      const response = await new Promise((resolve, reject) => {
        cloudscraper.head({
          url: source.url,
          followRedirect: true,
          timeout: 20000
        }, (error, response) => {
          if (error) reject(error);
          else resolve(response);
        });
      });

      if (response && response.statusCode === 200) {
        const contentLength = response.headers['content-length'];
        return {
          url: response.request.href,
          type: source.type,
          size: contentLength ? formatBytes(parseInt(contentLength)) : null,
          source: source.name
        };
      }
    } catch (error) {
      continue;
    }
  }

  return null;
}

async function downloadFileWithProgress(url, filepath, progressCallback) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    let downloadedBytes = 0;
    let totalBytes = 0;
    let lastReportedProgress = 0;

    const request = cloudscraper.get({
      url: url,
      encoding: null,
      timeout: 600000
    });

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`فشل التحميل: ${response.statusCode}`));
        return;
      }

      totalBytes = parseInt(response.headers['content-length'] || '0');
      
      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        file.write(chunk);

        if (totalBytes > 0 && progressCallback) {
          const progress = Math.floor((downloadedBytes / totalBytes) * 100);
          if (progress !== lastReportedProgress) {
            lastReportedProgress = progress;
            progressCallback(progress);
          }
        }
      });

      response.on('end', () => {
        file.end();
        if (progressCallback) progressCallback(100);
        resolve(true);
      });

      response.on('error', (error) => {
        file.end();
        reject(error);
      });
    });

    request.on('error', (error) => {
      file.end();
      reject(error);
    });
  });
}

async function handleCompressedApp(sock, chatId, app, zipPath, type) {
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    
    const apkEntry = entries.find(entry => 
      entry.entryName.endsWith('.apk') && !entry.entryName.includes('config.') && !entry.entryName.includes('split_config.')
    );
    
    const obbEntries = entries.filter(entry => entry.entryName.endsWith('.obb'));
    const splitApks = entries.filter(entry => 
      entry.entryName.includes('split_') && entry.entryName.endsWith('.apk')
    );

    if (apkEntry) {
      const apkBuffer = apkEntry.getData();
      const apkSizeMB = (apkBuffer.length / (1024 * 1024)).toFixed(2);
      
      await sock.sendMessage(chatId, {
        document: apkBuffer,
        mimetype: 'application/vnd.android.package-archive',
        fileName: `${sanitizeFilename(app.title)}.apk`,
        caption: `✅ *${app.title}*\n\n📦 الحجم: ${apkSizeMB} MB\n🎯 النوع: APK (مستخرج من ${type.toUpperCase()})\n\n${splitApks.length > 0 ? `⚠️ يحتوي على ${splitApks.length} ملف split إضافي` : ''}${obbEntries.length > 0 ? `\n🎮 يحتوي على ${obbEntries.length} ملف OBB` : ''}`,
        contextInfo: {
          externalAdReply: {
            title: app.title,
            body: `${BOT_NAME} - تحميل ناجح ✅`,
            thumbnailUrl: app.icon,
            sourceUrl: 'https://instagram.com/omarxarafp',
            mediaType: 1
          }
        }
      });

      if (obbEntries.length > 0) {
        await sendWithContext(sock, chatId, { 
          text: `📦 جاري رفع ${obbEntries.length} ملف OBB...\n\n⏳ الرجاء الانتظار` 
        });

        for (let i = 0; i < Math.min(obbEntries.length, 3); i++) {
          const obbEntry = obbEntries[i];
          const obbBuffer = obbEntry.getData();
          const obbSizeMB = (obbBuffer.length / (1024 * 1024)).toFixed(2);
          
          if (obbBuffer.length < 100 * 1024 * 1024) {
            try {
              await sock.sendMessage(chatId, {
                document: obbBuffer,
                mimetype: 'application/octet-stream',
                fileName: path.basename(obbEntry.entryName),
                caption: `🎮 *ملف OBB ${i + 1}/${obbEntries.length}*\n\n📦 ${path.basename(obbEntry.entryName)}\n💾 ${obbSizeMB} MB\n\n📁 ضعه في: Android/obb/${app.appId}/`,
                contextInfo: {
                  externalAdReply: {
                    title: 'ملف OBB - ' + app.title,
                    body: 'ملف بيانات إضافي للعبة',
                    thumbnailUrl: app.icon,
                    sourceUrl: 'https://instagram.com/omarxarafp',
                    mediaType: 1
                  }
                }
              });
            } catch (e) {
              await sendWithContext(sock, chatId, { 
                text: `⚠️ ملف OBB كبير جداً: ${obbSizeMB} MB\n\nيمكنك تحميله يدوياً من APKPure` 
              });
            }
          } else {
            await sendWithContext(sock, chatId, { 
              text: `⚠️ ملف OBB كبير جداً: ${obbSizeMB} MB\n\n📥 ${path.basename(obbEntry.entryName)}\n\nيمكنك تحميله يدوياً من APKPure` 
            });
          }
        }

        if (obbEntries.length > 3) {
          await sendWithContext(sock, chatId, { 
            text: `💡 يوجد ${obbEntries.length - 3} ملف OBB إضافي\n\nيمكنك تحميلهم من APKPure` 
          });
        }
      }

      if (splitApks.length > 0) {
        await sendWithContext(sock, chatId, { 
          text: `⚠️ *تنبيه مهم*\n\nهذا التطبيق يحتوي على ${splitApks.length} ملف split APK\n\nللتثبيت، استخدم:\n📱 SAI (Split APKs Installer)\n📱 APKPure App\n\nأو حمل النسخة الكاملة XAPK/APKS` 
        });
      }
    } else {
      const zipBuffer = fs.readFileSync(zipPath);
      const zipSizeMB = (zipBuffer.length / (1024 * 1024)).toFixed(2);
      
      await sock.sendMessage(chatId, {
        document: zipBuffer,
        mimetype: getMimeType(type),
        fileName: `${sanitizeFilename(app.title)}.${type}`,
        caption: `✅ *${app.title}*\n\n📦 الحجم: ${zipSizeMB} MB\n🎯 النوع: ${type.toUpperCase()}\n\n⚠️ استخدم SAI أو APKPure للتثبيت`,
        contextInfo: {
          externalAdReply: {
            title: app.title,
            body: `${BOT_NAME} - تحميل ناجح ✅`,
            thumbnailUrl: app.icon,
            sourceUrl: 'https://instagram.com/omarxarafp',
            mediaType: 1
          }
        }
      });
    }
  } catch (zipError) {
    const zipBuffer = fs.readFileSync(zipPath);
    const zipSizeMB = (zipBuffer.length / (1024 * 1024)).toFixed(2);
    
    await sock.sendMessage(chatId, {
      document: zipBuffer,
      mimetype: getMimeType(type),
      fileName: `${sanitizeFilename(app.title)}.${type}`,
      caption: `✅ *${app.title}*\n\n📦 الحجم: ${zipSizeMB} MB\n🎯 النوع: ${type.toUpperCase()}`,
      contextInfo: {
        externalAdReply: {
          title: app.title,
          body: `${BOT_NAME} - تحميل ناجح ✅`,
          thumbnailUrl: app.icon,
          sourceUrl: 'https://instagram.com/omarxarafp',
          mediaType: 1
        }
      }
    });
  }
}

function getMimeType(type) {
  const mimeTypes = {
    'apk': 'application/vnd.android.package-archive',
    'xapk': 'application/zip',
    'apks': 'application/zip',
    'obb': 'application/octet-stream'
  };
  return mimeTypes[type] || 'application/octet-stream';
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return bytes + ' B';
}

function sanitizeFilename(filename) {
  const invalid_chars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*', '\x00'];
  let cleaned = filename;
  
  for (const char of invalid_chars) {
    cleaned = cleaned.replace(new RegExp('\\' + char, 'g'), '_');
  }
  
  cleaned = cleaned.replace(/\s+/g, '_');
  cleaned = cleaned.replace(/__+/g, '_');
  cleaned = cleaned.replace(/^_+|_+$/g, '');
  
  if (cleaned.length > 100) {
    cleaned = cleaned.substring(0, 100);
  }
  
  return cleaned || 'app';
}

function formatNumber(num) {
  if (num >= 1000000000) return (num / 1000000000).toFixed(1) + 'B';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

setInterval(() => {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > 3600000) {
        fs.unlinkSync(filePath);
      }
    });
  } catch (e) {}
}, 600000);

process.on('uncaughtException', (error) => {
  console.error('❌ خطأ غير متوقع:', error.message);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ رفض غير معالج:', error.message);
});

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`🤖 ${BOT_NAME} Bot`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('⏳ جاري بدء التشغيل...');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

connectToWhatsApp().catch(error => {
  console.error('❌ فشل الاتصال:', error.message);
  setTimeout(() => process.exit(1), 2000);
});
