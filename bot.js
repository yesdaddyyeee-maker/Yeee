import { default as makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, getAggregateVotesInPollMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { createInterface } from 'readline';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const logger = pino({ level: 'silent' });

const rl = createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (text) => new Promise((resolve) => rl.question(text, resolve));

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    blue: '\x1b[34m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m'
};

const userSessions = new Map();
const pollMessages = new Map();

function executePythonScript(command, args = []) {
    return new Promise((resolve, reject) => {
        const python = spawn('python3', ['scraper.py', command, ...args]);
        let result = '';
        let error = '';

        python.stdout.on('data', (data) => {
            result += data.toString();
        });

        python.stderr.on('data', (data) => {
            error += data.toString();
        });

        python.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(error || 'Python script failed'));
            } else {
                try {
                    resolve(JSON.parse(result));
                } catch (e) {
                    reject(new Error('Failed to parse Python output'));
                }
            }
        });
    });
}

let pairingCodeRequested = false;
let globalSock = null;

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_session');
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger,
            browser: ['Windows', 'Chrome', '10.0'],
            version,
            syncFullHistory: false
        });

        globalSock = sock;
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            try {
                if (connection === 'connecting') {
                    console.log(`${colors.cyan}📡 جاري الاتصال بواتساب...${colors.reset}`);
                }

                if (!sock.authState.creds.registered && !pairingCodeRequested) {
                    pairingCodeRequested = true;
                    
                    try {
                        const phoneNumber = await question(`${colors.yellow}📱 أدخل رقم واتساب مع رمز الدولة (مثال: 966512345678): ${colors.reset}`);
                        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                        
                        console.log(`${colors.cyan}⏳ جاري طلب رمز الاقتران...${colors.reset}`);
                        const code = await sock.requestPairingCode(cleanNumber);
                        
                        console.log(`\n${colors.bright}${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
                        console.log(`${colors.bright}${colors.green}🔐 رمز الاقتران: ${code}${colors.reset}`);
                        console.log(`${colors.bright}${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
                        
                        console.log(`${colors.blue}📱 خطوات الربط:${colors.reset}`);
                        console.log(`${colors.blue}   1. افتح واتساب على هاتفك${colors.reset}`);
                        console.log(`${colors.blue}   2. اذهب إلى: الإعدادات > الأجهزة المرتبطة${colors.reset}`);
                        console.log(`${colors.blue}   3. اضغط على "ربط جهاز"${colors.reset}`);
                        console.log(`${colors.blue}   4. اختر "ربط بواسطة رقم الهاتف بدلاً من ذلك"${colors.reset}`);
                        console.log(`${colors.blue}   5. أدخل الرمز: ${colors.bright}${colors.green}${code}${colors.reset}\n`);
                        
                        rl.close();
                    } catch (err) {
                        console.error(`${colors.red}❌ خطأ في طلب رمز الاقتران: ${err.message}${colors.reset}`);
                        rl.close();
                    }
                }

                if (connection === 'open') {
                    console.log(`\n${colors.bright}${colors.green}✅ البوت متصل ويعمل بنجاح!${colors.reset}\n`);
                    console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
                    console.log(`${colors.cyan}💡 اكتب اسم أي تطبيق لتحميله${colors.reset}`);
                    console.log(`${colors.cyan}   مثال: واتساب، instagram، تيك توك${colors.reset}`);
                    console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
                }

                if (connection === 'close') {
                    const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                    
                    console.log(`${colors.red}❌ تم قطع الاتصال${colors.reset}`);
                    
                    if (reason === DisconnectReason.loggedOut) {
                        console.log(`${colors.red}تم تسجيل الخروج - احذف مجلد auth_session وأعد التشغيل${colors.reset}`);
                    } else if (reason !== DisconnectReason.connectionClosed && 
                               reason !== DisconnectReason.connectionLost &&
                               reason !== DisconnectReason.timedOut &&
                               reason !== DisconnectReason.restartRequired) {
                        console.log(`${colors.red}خطأ حرج - لن يتم إعادة الاتصال${colors.reset}`);
                    } else {
                        console.log(`${colors.yellow}🔄 إعادة الاتصال بعد 3 ثواني...${colors.reset}`);
                        setTimeout(() => connectToWhatsApp(), 3000);
                    }
                }
            } catch (error) {
                console.error(`${colors.red}❌ خطأ في معالجة الاتصال: ${error.message}${colors.reset}`);
            }
        });

        sock.ev.on('messages.update', async (updates) => {
            try {
                console.log(`${colors.cyan}🔔 استقبال messages.update event${colors.reset}`);
                console.log(`${colors.cyan}📋 عدد التحديثات: ${updates.length}${colors.reset}`);
                
                for (const { key, update } of updates) {
                    console.log(`${colors.cyan}📋 Update type: ${JSON.stringify(Object.keys(update))}${colors.reset}`);
                    
                    if (update.pollUpdates) {
                        console.log(`${colors.cyan}🔔 استقبال Poll update${colors.reset}`);
                        console.log(`${colors.cyan}📋 Poll updates count: ${update.pollUpdates.length}${colors.reset}`);
                        
                        const pollKey = key.id;
                        const pollData = pollMessages.get(pollKey);
                        
                        console.log(`${colors.cyan}📋 Poll ID: ${pollKey}${colors.reset}`);
                        console.log(`${colors.cyan}📋 Poll Data exists: ${!!pollData}${colors.reset}`);
                        
                        if (pollData) {
                            try {
                                console.log(`${colors.yellow}⏳ معالجة الأصوات...${colors.reset}`);
                                
                                // Get the poll message from stored data
                                const pollMessage = pollData.pollMessage;
                                
                                const pollUpdate = await getAggregateVotesInPollMessage({
                                    message: pollMessage,
                                    pollUpdates: update.pollUpdates,
                                });
                                
                                console.log(`${colors.cyan}📊 نتائج الأصوات:${colors.reset}`);
                                pollUpdate.forEach((option, idx) => {
                                    console.log(`${colors.cyan}   ${idx}. ${option.name}: ${option.voters.length} votes${colors.reset}`);
                                });
                                
                                // Find the first option with votes
                                const selectedOption = pollUpdate.find(v => v.voters.length > 0);
                                
                                if (selectedOption) {
                                    console.log(`${colors.green}✅ تم العثور على اختيار: ${selectedOption.name}${colors.reset}`);
                                    
                                    // Extract the index from the option name (format: "1. App Name")
                                    const match = selectedOption.name.match(/^(\d+)\./);
                                    if (match) {
                                        const selectedIndex = parseInt(match[1]) - 1;
                                        const selectedApp = pollData.searchResults[selectedIndex];
                                        
                                        if (selectedApp) {
                                            console.log(`${colors.green}✅ تم اختيار: ${selectedApp.title}${colors.reset}`);
                                            await handleAppDownload(sock, pollData.from, selectedApp.package, selectedApp.title);
                                            pollMessages.delete(pollKey);
                                        } else {
                                            console.log(`${colors.red}❌ التطبيق المختار غير موجود بالفهرس: ${selectedIndex}${colors.reset}`);
                                        }
                                    } else {
                                        console.log(`${colors.red}❌ فشل استخراج الفهرس من: ${selectedOption.name}${colors.reset}`);
                                    }
                                } else {
                                    console.log(`${colors.yellow}⚠️  لم يتم العثور على خيار به أصوات${colors.reset}`);
                                    console.log(`${colors.yellow}⚠️  Poll update data: ${JSON.stringify(update.pollUpdates, null, 2)}${colors.reset}`);
                                }
                            } catch (pollError) {
                                console.error(`${colors.red}❌ خطأ في معالجة Poll vote: ${pollError.message}${colors.reset}`);
                                console.error(pollError.stack);
                            }
                        } else {
                            console.log(`${colors.yellow}⚠️  لا توجد بيانات Poll محفوظة للـ ID: ${pollKey}${colors.reset}`);
                            console.log(`${colors.yellow}⚠️  Available poll IDs: ${Array.from(pollMessages.keys()).join(', ')}${colors.reset}`);
                        }
                    }
                }
            } catch (error) {
                console.error(`${colors.red}❌ خطأ في معالجة Poll: ${error.message}${colors.reset}`);
                console.error(error.stack);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            try {
                const msg = messages[0];
                if (!msg.message || msg.key.fromMe) return;

                // Skip poll update messages - they're handled in messages.update
                if (msg.message.pollUpdateMessage) {
                    return;
                }

                const text = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || '';
                const from = msg.key.remoteJid;

                if (!text.trim()) return;

                console.log(`${colors.cyan}📩 رسالة من ${from}: ${text}${colors.reset}`);

                await sock.sendMessage(from, { text: '🔍 جاري البحث...' });
                console.log(`${colors.yellow}🔍 البحث عن: ${text}${colors.reset}`);

                const searchResult = await executePythonScript('search_multiple', [text, '10']);
                
                if (searchResult.success && searchResult.results.length > 0) {
                    console.log(`${colors.green}✅ تم العثور على ${searchResult.results.length} نتيجة${colors.reset}`);
                    
                    const pollOptions = searchResult.results.map((app, index) => 
                        `${index + 1}. ${app.title} ⭐${app.score?.toFixed(1) || 'N/A'}`
                    );
                    
                    const pollMsg = await sock.sendMessage(from, {
                        poll: {
                            name: `📱 اختر التطبيق للتحميل:`,
                            values: pollOptions,
                            selectableCount: 1
                        }
                    });
                    
                    const pollDataToStore = {
                        searchResults: searchResult.results, 
                        from,
                        pollMessage: pollMsg.message || pollMsg,
                        pollId: pollMsg.key.id
                    };
                    
                    pollMessages.set(pollMsg.key.id, pollDataToStore);
                    
                    console.log(`${colors.blue}📊 تم إرسال Poll: ${pollMsg.key.id}${colors.reset}`);
                    console.log(`${colors.blue}📊 تم حفظ البيانات للـ Poll${colors.reset}`);
                } else {
                    console.log(`${colors.red}❌ لم يتم العثور على نتائج${colors.reset}`);
                    await sock.sendMessage(from, { text: '❌ لم يتم العثور على نتائج. حاول اسم تطبيق آخر.' });
                }
            } catch (error) {
                console.error(`${colors.red}❌ خطأ في معالجة الرسالة: ${error.message}${colors.reset}`);
                try {
                    const from = messages[0]?.key?.remoteJid;
                    if (from) {
                        await sock.sendMessage(from, { text: '❌ حدث خطأ. حاول مرة أخرى.' });
                    }
                } catch (e) {
                    console.error(`${colors.red}❌ فشل إرسال رسالة الخطأ${colors.reset}`);
                }
            }
        });

        return sock;
    } catch (error) {
        console.error(`${colors.red}❌ خطأ فادح في connectToWhatsApp: ${error.message}${colors.reset}`);
        throw error;
    }
}

async function handleAppDownload(sock, from, packageName, appTitle) {
    try {
        await sock.sendMessage(from, { text: `✅ تم العثور على: ${appTitle}\n📋 جاري جلب المعلومات...` });
        console.log(`${colors.cyan}📋 جلب معلومات: ${appTitle}${colors.reset}`);

        const appInfo = await executePythonScript('search', [packageName]);
        
        if (appInfo.success) {
            const infoText = `📱 *${appInfo.title}*

━━━━━━━━━━━━━━━━━━━━━━━━━
📦 الحزمة: ${appInfo.package}
🔖 الإصدار: ${appInfo.version}
⭐ التقييم: ${appInfo.score}/5
📥 التحميلات: ${appInfo.installs}
📂 الفئة: ${appInfo.genre}
💾 الحجم: ${appInfo.size || 'غير متوفر'}

📝 الوصف:
${appInfo.description}...

━━━━━━━━━━━━━━━━━━━━━━━━━
📥 جاري التحميل...`;

            await sock.sendMessage(from, { text: infoText });
            
            if (appInfo.icon) {
                try {
                    await sock.sendMessage(from, {
                        image: { url: appInfo.icon },
                        caption: `أيقونة ${appInfo.title}`
                    });
                    console.log(`${colors.green}✅ تم إرسال الأيقونة${colors.reset}`);
                } catch (e) {
                    console.log(`${colors.yellow}⚠️  فشل إرسال الأيقونة${colors.reset}`);
                }
            }
        }

        console.log(`${colors.yellow}📥 بدء التحميل...${colors.reset}`);
        const downloadResult = await executePythonScript('download', [packageName, appTitle]);

        if (downloadResult.success) {
            console.log(`${colors.green}✅ تم التحميل: ${downloadResult.size_mb} MB${colors.reset}`);
            
            await sock.sendMessage(from, { 
                text: `✅ تم التحميل بنجاح!\n💾 الحجم: ${downloadResult.size_mb} MB\n⏳ جاري الإرسال...` 
            });

            console.log(`${colors.cyan}📤 إرسال الملف...${colors.reset}`);
            
            const fileBuffer = fs.readFileSync(downloadResult.filename);
            const fileName = path.basename(downloadResult.filename);
            
            await sock.sendMessage(from, {
                document: fileBuffer,
                fileName: fileName,
                mimetype: 'application/vnd.android.package-archive',
                caption: `📱 ${appTitle}\n💾 ${downloadResult.size_mb} MB`
            });

            console.log(`${colors.green}✅ تم إرسال الملف بنجاح${colors.reset}`);
            await sock.sendMessage(from, { text: '✅ تم إرسال الملف بنجاح!' });
            
            try {
                fs.unlinkSync(downloadResult.filename);
                console.log(`${colors.blue}🗑️  تم حذف الملف المؤقت${colors.reset}`);
            } catch (e) {
                console.log(`${colors.yellow}⚠️  فشل حذف الملف المؤقت${colors.reset}`);
            }
        } else {
            console.log(`${colors.red}❌ فشل التحميل${colors.reset}`);
            await sock.sendMessage(from, { text: '❌ فشل التحميل. حاول تطبيق آخر.' });
        }
    } catch (error) {
        console.error(`${colors.red}❌ خطأ في handleAppDownload: ${error.message}${colors.reset}`);
        try {
            await sock.sendMessage(from, { text: '❌ حدث خطأ أثناء التحميل.' });
        } catch (e) {
            console.error(`${colors.red}❌ فشل إرسال رسالة الخطأ${colors.reset}`);
        }
    }
}

console.log(`${colors.bright}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
console.log(`${colors.bright}${colors.cyan}🤖 بوت واتساب لتحميل التطبيقات${colors.reset}`);
console.log(`${colors.bright}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

connectToWhatsApp().catch(err => {
    console.error(`${colors.red}❌ خطأ فادح: ${err.message}${colors.reset}`);
    console.error(`${colors.red}❌ سيتم إيقاف البوت${colors.reset}`);
    process.exit(1);
});
