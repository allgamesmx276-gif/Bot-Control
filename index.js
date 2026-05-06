import fs from 'fs';
import path from 'path';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode-terminal';
import cron from 'node-cron';
import moment from 'moment';
import 'moment/locale/es.js';
import axios from 'axios';
import { translate } from 'google-translate-api-x';
import { globalDb, getGroupDb, getResponsesDb } from './db_manager.js';
import { getPrivateMsgsDb } from './private_db.js';

moment.locale('es');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // Ayuda mucho en VPS de 1 solo core
            '--disable-gpu'
        ],
        handleSIGINT: false
    }
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Escanea el código QR para iniciar sesión:');
});

client.on('ready', () => {
    console.log('¡Bot listo y conectado!');
    setupScheduler();
});

client.on('message', async (msg) => {
    const chat = await msg.getChat();
    const isGroup = chat.isGroup;
    const body = msg.body;
    const sender = msg.author || msg.from;

    // Muted Check
    if (isGroup && globalDb.data.mutedUsers[sender]) {
        const muteInfo = globalDb.data.mutedUsers[sender];
        if (Date.now() < muteInfo.until) {
            try {
                await msg.delete(true);
                return; // No procesar comandos si está muteado
            } catch (e) {
                console.error('Error eliminando mensaje de usuario muteado:', e);
            }
        } else {
            delete globalDb.data.mutedUsers[sender];
            await globalDb.write();
        }
    }

    // AFK Check
    if (globalDb.data.afk[sender]) {
        const afkData = globalDb.data.afk[sender];
        delete globalDb.data.afk[sender];
        await globalDb.write();
        await msg.reply(`*¡BIENVENIDO DE NUEVO!* 👋\n\nHas salido del modo *AFK*.\n• *Ausente por:* ${moment(afkData.time).fromNow(true)}\n• *Motivo:* ${afkData.reason}`);
    }

    if (msg.mentionedIds) {
        for (const jid of msg.mentionedIds) {
            if (globalDb.data.afk[jid]) {
                const info = globalDb.data.afk[jid];
                await msg.reply(`*USUARIO AUSENTE* 💤\n\nEl usuario que mencionaste está *AFK*.\n• *Motivo:* ${info.reason}\n• *Tiempo:* Hace ${moment(info.time).fromNow()}`);
            }
        }
    }

    // Auto-responses (Globales o por grupo si se quisiera filtrar, actualmente globales)
    const lowerText = body.toLowerCase();
    
    // 1. Verificar si es una consulta de SERVICIO flexgsm.com
    const searchFlexGSM = async (query) => {
        try {
            console.log(`Buscando en FlexGSM: ${query}`);
            const shouldRefresh = (Date.now() - flexCache.lastUpdate) > 600000; // Refresco cada 10 min
            if (flexCache.data.length === 0 || shouldRefresh) {
                console.log('Refrescando caché de FlexGSM...');
                const urls = [
                    'https://flexgsm.com/remote/service',
                    'https://flexgsm.com/imei/service',
                    'https://flexgsm.com/group/xiaomi',
                    'https://flexgsm.com/server/service'
                ];
                
                const results = [];
                for (const url of urls) {
                    try {
                        const response = await axios.get(url, {
                            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
                        });
                        const html = response.data;
                        
                        // Nuevo parser ULTRA robusto basado en JSON inyectado (FlexGSM usa data objects en el script)
                        const jsonDataMatch = html.match(/var\s+services\s*=\s*(\[[\s\S]*?\]);/);
                        if (jsonDataMatch) {
                            try {
                                const services = JSON.parse(jsonDataMatch[1]);
                                services.forEach(s => {
                                    if (s.title && s.url) {
                                        results.push({
                                            name: s.title.replace(/^@\s*/, '').trim(),
                                            price: s.pricetext || `${s.price} ${s.currency || 'USD'}`,
                                            wait: s.delivery_time || 'Instant',
                                            link: s.url
                                        });
                                    }
                                });
                            } catch (e) {
                                console.error("Error parseando JSON de FlexGSM:", e.message);
                            }
                        }

                        // Fallback: Si no hay JSON, usamos el regex de bloques <a> mejorado
                        if (results.length === 0) {
                            const productLinks = html.match(/<a[^>]*href="[^"]*\/service\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi) || [];
                            productLinks.forEach(linkHtml => {
                                const hrefMatch = linkHtml.match(/href="([^"]+)"/i);
                                if (!hrefMatch) return;
                                const href = hrefMatch[1];
                                const link = href.startsWith('http') ? href : `https://flexgsm.com${href.startsWith('/') ? '' : '/'}${href}`;

                                const textCombined = linkHtml.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
                                const priceMatch = textCombined.match(/(\d+\.?\d*)\s*(USD|EUR|MXN|CREDITS)/i);
                                
                                if (priceMatch) {
                                    const priceText = priceMatch[0];
                                    const parts = textCombined.split(priceMatch[0]);
                                    let name = parts[0].trim().replace(/^@\s*/, ''); 
                                    const wait = parts[1] ? parts[1].trim() : 'Instant';

                                    if (name.length > 3 && !name.includes('Account Status') && !name.includes('Login')) {
                                        results.push({
                                            name: name,
                                            price: priceText,
                                            wait: wait || 'Instant',
                                            link: link
                                        });
                                    }
                                }
                            });
                        }
                    } catch (err) {
                        console.error(`Error cargando URL ${url}:`, err.message);
                    }
                }

                if (results.length > 0) {
                    flexCache.data = results;
                    flexCache.lastUpdate = Date.now();
                    console.log(`Caché actualizado: ${results.length} productos de ambas categorías.`);
                } else {
                    console.log('No se pudieron extraer productos.');
                }
            }

            const rawLower = query.toLowerCase().trim();
            const startsWithBot = rawLower.startsWith('bot ');
            
            // Lógica de Prefijos: bot [seccion] [busqueda]
            // Ejemplo: "bot imei blacklist colombia"
            let targetCategory = null; // 'imei', 'server', 'remote', 'direct'
            let searchContent = rawLower;

            if (startsWithBot) {
                const parts = rawLower.split(/\s+/);
                if (parts.length >= 3) {
                    const prefix = parts[1];
                    if (['imei', 'server', 'remote', 'direct'].includes(prefix)) {
                        targetCategory = prefix;
                        searchContent = parts.slice(2).join(' ');
                    } else {
                        searchContent = parts.slice(1).join(' ');
                    }
                } else {
                    searchContent = parts.slice(1).join(' ');
                }
            }

            const cleanQuery = searchContent
                .replace(/méxico/gi, 'mexico')
                .replace(/méxic/gi, 'mexico')
                .replace(/renta|licencia|activacion|tiempo|creditos|cuanto|cuesta|de|la|el|flexgsm|informacion|info|precio|buscame|busca|bot|\?/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
            
            console.log(`Query Final: "${cleanQuery}" | Categoría: ${targetCategory || 'Todas'}`);
            
            if (cleanQuery.length < 2) return null;

            // ANALISIS DE ORDEN Y PRIORIDAD
            const rawWords = cleanQuery.split(/\s+/);
            const isRentaRequested = rawLower.includes('renta');
            const isLicenciaRequested = rawLower.includes('licencia') || rawLower.includes('activacion') || rawLower.includes('tiempo');
            
            // Detectar especificación de tiempo (ej: 6h, 12h, 15m, 1m)
            const timeMatch = rawLower.match(/(\d+)\s*(h|m|d|hrs|min|mes|meses)/i);
            const timeSpec = timeMatch ? timeMatch[1] + timeMatch[2].toLowerCase() : null;
            const timeNum = timeMatch ? timeMatch[1] : null;

            const startsWithMexico = rawWords.includes('mexico');
            const isMiAccountQuery = cleanQuery.includes('mi account') || cleanQuery.includes('micloud') || cleanQuery.includes('mi cloud') || cleanQuery.includes('xiaomi');
            const isSpecificTramiteSearch = /acta|nacimiento|curp|repuve|afore|sat|rfc|covid|carnet/i.test(cleanQuery);

            // Filtramos palabras muy comunes o cortas
            const queryWords = cleanQuery.split(/\s+/)
                .filter(w => w.length >= 2 || (w.length === 1 && /\d/.test(w)));

            // Búsqueda inteligente: 
            let matches = flexCache.data.filter(p => {
                const pName = p.name.toLowerCase();
                const pLink = (p.link || '').toLowerCase();
                const pPrice = (p.price || '').toLowerCase();

            // 1. FILTRADO POR CATEGORÍA TÉCNICA (SOLO SI HAY PREFIJO EXPLÍCITO)
            if (targetCategory) {
                if (targetCategory === 'imei' && !pLink.includes('imei/service')) return false;
                if (targetCategory === 'server' && !pLink.includes('server/service')) return false;
                if (targetCategory === 'remote' && !pLink.includes('remote/service')) return false;
                if (targetCategory === 'direct' && !pLink.includes('service-group')) return false;
            }

                // EXCLUIR PRODUCTOS SIN PRECIO O CON PRECIO 0
                if (!pPrice || pPrice === '0' || pPrice === '0.00' || pPrice.includes(' 0.00')) return false;
                
                // Grupos administrativos/basura
                const isGenericMexico = pName.includes('⚡') || 
                                       pLink.includes('/group/tramites-mexico') || 
                                       pLink.includes('/group/limpiezas-de-imei-mexico') ||
                                       pLink.includes('/group/mexico-carrier-check') ||
                                       pLink.includes('/group/tramites');

                // LÓGICA DE PRIORIDAD POR RENTA/LICENCIA Y TIEMPO ESPECÍFICO
                if (isRentaRequested) {
                    // Si pide renta, priorizamos los que dicen 'rent' o 'hrs' o 'hours'
                    if (!(pName.includes('rent') || pName.includes('hrs') || pName.includes('hours'))) return false;
                    
                    // Si especificó tiempo (ej: 12h), filtrar estrictamente
                    if (timeNum) {
                        const pNameLower = pName.toLowerCase();
                        const timeRegex = new RegExp(`\\b${timeNum}\\b\\s*(h|m|d|hrs|min|mes|meses)?`, 'i');
                        const hasExactTime = timeRegex.test(pNameLower);
                        
                        if (!hasExactTime) return false;
                    }
                }
                if (isLicenciaRequested && (pName.includes('rent') || pName.includes('hrs') || pName.includes('hours'))) return false;

                // --- PROTECCIÓN CONTRA RESULTADOS DE RENTA CUANDO NO SE SOLICITAN ---
                // Si el usuario NO pidió renta específicamente, pero el producto es una renta, lo descartamos
                // para evitar que "esim telcel" devuelva "unlocktool rent" por coincidencia parcial.
                if (!isRentaRequested && (pName.includes('rent') || pName.includes(' 6 hrs') || pName.includes(' 12 hrs'))) {
                    // Solo permitimos si la búsqueda incluye explícitamente palabras de herramientas que suelen ser rentadas
                    const tools = ['unlocktool', 'chimera', 'z3x', 'octopus', 'hydra', 'pandora', 'tsm', 'dft', 'eft', 'zentrix', 'guard'];
                    if (!tools.some(t => queryWords.includes(t))) {
                        return false;
                    }
                }

                // LÓGICA DE BLOQUEO PARA MI ACCOUNT
                if (isMiAccountQuery) {
                    if (isGenericMexico) return false;
                    const hasXiaomiMark = pName.includes('xiaomi') || pName.includes('mi account') || pName.includes('micloud') || pName.includes('mi cloud');
                    if (!hasXiaomiMark) return false;
                }

                // SI el usuario busca un trámite específico
                if (isSpecificTramiteSearch) {
                    return queryWords.every(word => pName.includes(word));
                }

                // --- FILTRO DE MARCAS/SERVICIOS EXCLUSIVOS (Ej: Telcel vs Movistar) ---
                const brands = ['telcel', 'movistar', 'att', 'at&t', 'wom', 'claro', 't-mobile', 'tmobile', 'verizon'];
                const queryBrand = brands.find(b => queryWords.includes(b));
                if (queryBrand) {
                    const otherBrands = brands.filter(b => b !== queryBrand);
                    // Si el nombre del producto contiene una marca que NO es la buscada, lo descartamos
                    if (otherBrands.some(ob => pName.includes(ob))) return false;
                }

                // Si no es trámite específico y "mexico" no es la primera palabra, bloqueamos trámites
                if (!startsWithMexico && isGenericMexico) {
                    return false;
                }

                // --- MEJORA DE COINCIDENCIA POR PALABRA EXACTA ---
                const pWords = pName.split(/[\s,.\-\[\]()|/&]+/).map(w => w.toLowerCase());
                
                return queryWords.every(qWord => {
                    if (qWord === 'bot') return true;
                    // Si el qWord es parte de la detección de tiempo (ej: '12h'), lo ignoramos en el loop 'every'
                    // porque ya lo validamos arriba en la lógica de tiempo específico.
                    if (timeNum && (qWord === timeNum || qWord === timeSpec || qWord.startsWith(timeNum))) return true;

                    // Normalización especial para términos técnicos y marcas
                    const isCommonTerm = /esim|imei|frp|nck|blacklist|colombia|zentrix|guard|remote|nautrix|mdm|tool/.test(qWord);

                    if (qWord.length <= 4 && !isCommonTerm) {
                        return pWords.includes(qWord);
                    }
                    // Búsqueda más flexible para términos técnicos y palabras largas
                    return pName.includes(qWord);
                });
            });

            // 2. LÓGICA DE RECUPERACIÓN (SI NO HAY COINCIDENCIA TOTAL)
            if (matches.length === 0) {
                matches = flexCache.data.filter(p => {
                    const pName = p.name.toLowerCase();
                    const pLink = (p.link || '').toLowerCase();
                    const pPrice = (p.price || '').toLowerCase();

                    if (!pPrice || pPrice === '0' || pPrice === '0.00' || pPrice.includes(' 0.00')) return false;
                    
                    if (targetCategory === 'imei' && !pLink.includes('imei/service')) return false;
                    if (targetCategory === 'server' && !pLink.includes('server/service')) return false;
                    if (targetCategory === 'remote' && !pLink.includes('remote/service')) return false;
                    if (targetCategory === 'direct' && !pLink.includes('service-group')) return false;

                    // Si coinciden al menos el 70% de las palabras clave (ignorando 'tool' si es genérico)
                    const relevantQuery = queryWords.filter(w => w !== 'bot' && w !== 'tool');
                    const hits = relevantQuery.filter(qW => pName.includes(qW));
                    return hits.length >= Math.ceil(relevantQuery.length * 0.7);
                });
            }

            // ELIMINAR DUPLICADOS POR NOMBRE
            const uniqueMatches = [];
            const seenNames = new Set();
            for (const match of matches) {
                const nameKey = match.name.toLowerCase().trim();
                if (!seenNames.has(nameKey)) {
                    seenNames.add(nameKey);
                    uniqueMatches.push(match);
                }
            }

            // Ordenamiento por relevancia (exactitud de palabras clave)
            return uniqueMatches.sort((a, b) => {
                const aName = a.name.toLowerCase();
                const bName = b.name.toLowerCase();
                // Si uno contiene la frase exacta y el otro no
                if (aName.includes(cleanQuery) && !bName.includes(cleanQuery)) return -1;
                if (!aName.includes(cleanQuery) && bName.includes(cleanQuery)) return 1;
                return aName.length - bName.length;
            });
        } catch (e) {
            console.error('Error fetching FlexGSM:', e);
            return null;
        }
    };

    if (lowerText === 'tools rent') {
        const toolsMsg = `🌎 🛠️ *TOOLS RENT – ACCESO REMOTO* 🛠️\n\n` +
            `🔓 *Tools disponibles:*\n` +
            `💚 UnlockTool — https://flexgsm.com/service/unlock-tool-rent-for-6-hours\n` +
            `🔵 MultiUnlock — https://flexgsm.com/service/mutiunlock-tool\n` +
            `🟡 TFM Tool — https://flexgsm.com/service/tfm-tool-tfmtool-com-12-hrs-main-server\n` +
            `🟠 TSM Tool — https://flexgsm.com/service/tsm-tool-rent-12-hours\n` +
            `🟣 AMT — https://flexgsm.com/service/amt-android-multi-tool-rent-3-hours\n` +
            `🕵️ Anonyshu — https://flexgsm.com/service/anonyshu-tool-rent-12-hours\n` +
            `🧩 CF Tools — https://flexgsm.com/service/cf-tools-rent-6-hours\n` +
            `🐆 Cheetah Tool — https://flexgsm.com/service/cheetah-tool-rent-4-hours\n` +
            `🔴 DFT Pro — https://flexgsm.com/service/dft-pro-tool-rent-48-hours\n` +
            `🟤 EFT Pro — https://flexgsm.com/service/eft-pro-dongal-rent-60-minutes\n` +
            `🔹 FRT — https://flexgsm.com/service/frt-tool-dongal-rent-for-60-minutes\n` +
            `👑 Griffin Premium — https://flexgsm.com/service/griffin-unlocker-premium-account-tool-rent-6-hours\n` +
            `⭐ Griffin Normal — https://flexgsm.com/service/griffin-unlocker-tool-rent-6-hours\n` +
            `🐍 Hydra Tool — https://flexgsm.com/service/hydra-tool-rent-without-dongle-24-hours\n` +
            `🧠 SamsTool — https://flexgsm.com/service/z3x-samstool-digital-tool-rent-12-hours-no-auto-login\n` +
            `🛠️ TR Tool Pro — https://flexgsm.com/service/tr-tools-pro-rent-instant\n` +
            `➕ Sigma Plus — https://flexgsm.com/service/sigma-plus-dongle-rent-30-60-miinutes\n` +
            `🕒 RTC Tool — https://flexgsm.com/service/rtc-tool-rent-12-hours\n` +
            `🔐 Pandora Tool — https://flexgsm.com/service/pandora-tool-digital-login-rent-48-hours\n` +
            `🐙 Octoplus — https://flexgsm.com/service/octoplus-frp-dongal-rent-60-minutes\n` +
            `📱 MST MobilSea — https://flexgsm.com/service/mst-mobilesea-sevice-tool-6-hours-instant\n` +
            `🧩 MDM Fix Tool — https://flexgsm.com/service/mdm-fix-tool-rent-6-hours\n` +
            `🔓 KG Killer Tool — https://flexgsm.com/service/kg-killer-tool-rent-4-hours\n` +
            `🔥 Fenix Tool Pro — https://flexgsm.com/service/fenix-tool`;
        await msg.reply(toolsMsg);
        return;
    }

    // COMANDOS DE CONTROL DE SERVIDOR (Desactivado permanente el uso del server por errores de filtrado)
    if (lowerText === 'server on' || lowerText === 'server off') {
        await msg.reply('🛑 *SISTEMA FLEXGSM DESACTIVADO PERMANENTEMENTE*\n\nEl motor de búsqueda ha sido deshabilitado por el administrador debido a errores de filtrado. Solo funcionan los comandos manuales y utilidades.');
        return;
    }

    // El servidor siempre se considera "off" internamente ahora
    const isServerDisabled = true; 

    // MODALIDAD CHATBOT INTERACTIVO
    const botKeywords = ['bot', 'buscame', 'busca', 'precio', 'info', 'informacion'];
    const startsWithBot = botKeywords.some(key => lowerText.startsWith(key));
    const isSlashCmd = lowerText.startsWith('/');
    const isMCmd = lowerText.startsWith('m ');
    const isDirectAdmin = ['addmsg', 'turno', 'open', 'close', 'ban', 'mute', 'unmute', 'r ', 'rlist', 'rdel', 'addserv', 'msglist', 'msgdel', 'padd', 'plist', 'pdel'].some(cmd => lowerText.startsWith(cmd));
    const privateDb = await getPrivateMsgsDb();

    // Verificación de Admin para el grupo actual (global para este scope)
    const contactMsg = await msg.getContact();
    let isAdmin = false;
    if (isGroup) {
        const participant = chat.participants.find(p => p.id._serialized === contactMsg.id._serialized);
        isAdmin = participant?.isAdmin || participant?.isSuperAdmin;
    }

    // Comando para enviar mensaje privado al mencionar al bot sobre un mensaje
    if (msg.hasQuotedMsg && (body.toLowerCase().includes('@' + client.info.wid.user) || body.toLowerCase().startsWith('m pm'))) {
        if (!isAdmin) return;
        
        const quoted = await msg.getQuotedMessage();
        const targetNumber = quoted.author || quoted.from;
        
        // Cargar bases de datos del grupo para comandos específicos
        const groupDb = isGroup ? await getGroupDb(chat.id._serialized) : null;
        const groupResponsesDb = isGroup ? await getResponsesDb(chat.id._serialized) : null;
        
        // Verificar límites
        const history = privateDb.data.history[targetNumber] || { count: 0, lastSent: 0 };
        const now = Date.now();
        
        if (history.count >= 3) {
            await msg.reply('❌ Límite alcanzado: Máximo 3 mensajes por privado para este usuario.');
            return;
        }
        
        // Intervalo anti-ban (60 segundos entre mensajes al mismo usuario)
        if (now - history.lastSent < 60000) {
            await msg.reply('⏳ Espera un minuto antes de enviar otro mensaje al mismo usuario.');
            return;
        }

        // Elegir plantilla
        const argsPM = body.split(' ');
        const templateIdx = parseInt(argsPM[argsPM.length - 1]) - 1;
        const template = privateDb.data.templates[templateIdx];

        if (!template) {
            await msg.reply('❌ Indica un número de plantilla válido. Ejemplo: `@Bot 1` o `m pm 1`');
            return;
        }

        try {
            await client.sendMessage(targetNumber, template.text);
            history.count++;
            history.lastSent = now;
            privateDb.data.history[targetNumber] = history;
            await privateDb.write();
            await msg.reply(`✅ Mensaje enviado al privado (#${history.count}/3).`);
        } catch (e) {
            await msg.reply('❌ Error al enviar el mensaje privado.');
        }
        return;
    }

    // Cargar bases de datos de grupo solo si se necesitan más adelante
    const groupDb = isGroup ? await getGroupDb(chat.id._serialized) : null;
    const groupResponsesDb = isGroup ? await getResponsesDb(chat.id._serialized) : null;

    // 1. PRIORIDAD MÁXIMA: Respuestas automáticas guardadas del grupo
    if (groupResponsesDb) {
        const foundResponse = Object.entries(groupResponsesDb.data.responses).find(([key, val]) => {
            const triggers = key.split(',').map(t => t.trim().toLowerCase());
            return triggers.includes(lowerText);
        });

        if (foundResponse) {
            const resData = foundResponse[1];
            if (typeof resData === 'object' && resData.type === 'media') {
                const mediaPath = path.join('database', resData.filename);
                if (fs.existsSync(mediaPath)) {
                    const media = MessageMedia.fromFilePath(mediaPath);
                    await msg.reply(media, undefined, { caption: resData.caption });
                } else {
                    await msg.reply('❌ El archivo de imagen no se encuentra en el servidor.');
                }
            } else {
                await msg.reply(resData);
            }
            return;
        }
    }

// REGLA DE SALIDA: Si no es comando ni empieza con palabras clave de admin, ignorar
    if (!isSlashCmd && !isMCmd && !isDirectAdmin) {
        return;
    }

    // Prefix commands (Ajuste para convertir slash en comando)
    const bodyText = msg.body;
    // Usar las variables ya declaradas arriba (isMCmd, isSlashCmd, isDirectAdmin)
    const isM = isMCmd;
    const isSlash = isSlashCmd;

    if (isM || isSlash || isDirectAdmin) {
        let prefixLen = 0;
        if (isM) prefixLen = 2;
        else if (isSlash) prefixLen = 1;
        else if (isDirectAdmin) {
            // Comandos que pueden no tener prefijo
            if (bodyText.toLowerCase().startsWith('r ')) prefixLen = 2;
            else if (bodyText.toLowerCase().startsWith('rlist')) prefixLen = 5;
            else if (bodyText.toLowerCase().startsWith('rdel')) prefixLen = 4;
            else if (bodyText.toLowerCase().startsWith('addserv')) prefixLen = 7;
        }

        const args = bodyText.slice(prefixLen).trim().split(/ +/);
        // Ajuste para comandos directos
        let command = '';
        if (isDirectAdmin) {
            if (bodyText.toLowerCase().startsWith('r ')) command = 'r';
            else if (bodyText.toLowerCase().startsWith('rlist')) command = 'rlist';
            else if (bodyText.toLowerCase().startsWith('rdel')) command = 'rdel';
            else if (bodyText.toLowerCase().startsWith('addserv')) command = 'addserv';
            else command = args.shift()?.toLowerCase() || '';
        } else {
            command = args.shift()?.toLowerCase() || '';
        }

        // Si usa un comando de admin directamente o con "m ", ignoramos si no es admin
        if ((isDirectAdmin || isM) && !isAdmin && !isSlash) return;

        const contactCmd = await msg.getContact();

        switch (command) {
            case 'menu':
                let menuText = '';
                if (isAdmin) {
                    menuText = `╔══════════════════╗\n` +
                               `║      🌟 *MÉNU ADMIN* 🌟    ║\n` +
                               `╠══════════════════╣\n\n` +
                               `⌚ *GESTIÓN DE TURNOS*\n` +
                               `• *m turno [inicio] [cierre]*\n` +
                               `• *m turno on* / *off*\n` +
                               `• *m addmsg [0-7]* (Rep. msj)\n` +
                               `• *msglist* / *msgdel [id]*\n\n` +
                               `🛡️ *ADMINISTRACIÓN*\n` +
                               `• *m open* / *m close*\n` +
                               `• *mutetime [t]* (Resp. msj)\n` +
                               `• *r [palabras]* (Resp. msj)\n` +
                               `• *rlist* / *rdel [palabra]*\n` +
                               `• *addserv* (Manual de precios)\n` +
                               `• *m ban* (Resp. msj)\n\n` +
                               `📩 *MENSAJES PRIVADOS*\n` +
                               `• *m pm [1-n]* (Resp. msj)\n` +
                               `• *padd* (Resp. msj)\n` +
                               `• *plist* / *pdel [id]*\n\n` +
                               `💤 *UTILIDADES*\n` +
                               `• */afk [motivo]*\n` +
                               `• */convert [cant] [de] [a]*\n` +
                               `• */traducir* (Resp. msj)\n` +
                               `╚══════════════════╝`;
                } else {
                    menuText = `╔══════════════════╗\n` +
                               `║      👤 *MÉNU USUARIO* 👤  ║\n` +
                               `╠══════════════════╣\n\n` +
                               `💤 *UTILIDADES*\n` +
                               `• */afk [motivo]*\n` +
                               `• */convert [cant] [de] [a]*\n` +
                               `• */traducir* (Resp. msj)\n` +
                               `• */menu* (Este menú)\n\n` +
                               `💸 *EJEMPLO DIVISAS:*\n` +
                               `_/convert 10 usd mxn_\n` +
                               `╚══════════════════╝`;
                }
                
                const dmChat = await contactCmd.getChat();
                await dmChat.sendMessage(menuText);
                if (isGroup) await msg.reply('✅ *Menú enviado al privado.*');
                break;

            case 'convert':
                if (args.length < 3) {
                    await msg.reply('❌ Uso: `/convert [monto] [moneda_origen] [moneda_destino]`\nEjemplo: `/convert 100 usd mxn`');
                    break;
                }
                const amount = parseFloat(args[0]);
                const from = args[1].toUpperCase();
                const to = args[2].toUpperCase();

                if (isNaN(amount)) {
                    await msg.reply('❌ Por favor ingresa un número válido.');
                    break;
                }

                try {
                    // Usando una API gratuita sin key (Frankfurter) para rapidez
                    const res = await axios.get(`https://api.frankfurter.app/latest?amount=${amount}&from=${from}&to=${to}`);
                    const result = res.data.rates[to];
                    const rateDate = res.data.date;
                    const textConvert = `╔══════════════════╗\n` +
                                        `║    💰 *CONVERSOR LIVE* 💰   ║\n` +
                                        `╠══════════════════╣\n` +
                                        `  *Entrada:* ${amount} ${from}\n` +
                                        `  *Resultado:* ${result.toFixed(2)} ${to}\n` +
                                        `╠══════════════════╣\n` +
                                        `  _Tipo de cambio del: ${rateDate}_\n` +
                                        `  _Actualizado en tiempo real_ 📈\n` +
                                        `╚══════════════════╝`;
                    await msg.reply(textConvert);
                } catch (e) {
                    await msg.reply('❌ Error: Asegúrate de usar códigos válidos (USD, MXN, EUR, GBP, etc).');
                }
                break;

            case 'traducir':
                if (!msg.hasQuotedMsg) {
                    await msg.reply('❌ Debes responder a un mensaje para traducirlo.\n\n*Ejemplos:*\n• `/traducir` (auto -> español)\n• `/traducir eng` (a inglés)\n• `/traducir pt` (a portugués)');
                    break;
                }
                const quotedToTranslate = await msg.getQuotedMessage();
                let targetLang = args[0] ? args[0].toLowerCase() : 'es';
                
                // Mapeo automático de códigos comunes para evitar errores
                if (targetLang === 'eng') targetLang = 'en';
                if (targetLang === 'esp') targetLang = 'es';
                if (targetLang === 'por') targetLang = 'pt';
                if (targetLang === 'fra') targetLang = 'fr';
                if (targetLang === 'ita') targetLang = 'it';
                if (targetLang === 'jap') targetLang = 'ja';
                if (targetLang === 'chi') targetLang = 'zh-CN';

                try {
                    const resultTranslate = await translate(quotedToTranslate.body, {
                        to: targetLang,
                        forceBatch: false,
                        forceTo: true
                    });
                    
                    const translatedText = resultTranslate.text;
                    const fromLang = (resultTranslate.from && resultTranslate.from.language && resultTranslate.from.language.iso) ? resultTranslate.from.language.iso.toUpperCase() : 'AUTO';
                    const toLang = targetLang.toUpperCase();

                    const textTranslate = `╔══════════════════╗\n` +
                                         `║     📖 *TRADUCCIÓN* 📖    ║\n` +
                                         `╠══════════════════╣\n` +
                                         `  *De:* ${fromLang} ➡️ *A:* ${toLang}\n` +
                                         `╠══════════════════╣\n\n` +
                                         `${translatedText}\n\n` +
                                         `╚══════════════════╝`;
                    await msg.reply(textTranslate);
                } catch (e) {
                    console.error('Error traduciendo:', e);
                    await msg.reply('❌ Error al traducir. Verifica el código de idioma (ej: es, en, pt, fr).');
                }
                break;

            case 'turno':
                if (!isAdmin || !groupDb) break;
                if (args[0] === 'on' || args[0] === 'off') {
                    groupDb.data.active = args[0] === 'on';
                    await groupDb.write();
                    await msg.reply(`✅ *TURNO AUTOMÁTICO:* ${groupDb.data.active ? 'ACTIVADO 🟢' : 'DESACTIVADO 🔴'}`);
                } else if (args.length === 2) {
                    groupDb.data.openTime = args[0];
                    groupDb.data.closeTime = args[1];
                    groupDb.data.active = true;
                    await groupDb.write();
                    await msg.reply(`✅ *TURNO CONFIGURADO Y ACTIVADO*\n⌚ *Inicio:* ${args[0]}\n⌛ *Cierre:* ${args[1]}`);
                }
                break;

            case 'addmsg':
                if (!isAdmin || !groupDb) break;
                if (!msg.hasQuotedMsg) {
                    await msg.reply('❌ Debes responder a un mensaje para guardarlo.');
                    break;
                }
                const quotedMsg = await msg.getQuotedMessage();
                const days = parseInt(args[0]); // 0 = perm, 1-7 = días
                const msgContent = quotedMsg.body;
                
                if (msgContent && !isNaN(days) && days >= 0 && days <= 7) {
                    const expiry = days === 0 ? null : Date.now() + (days * 24 * 60 * 60 * 1000);
                    groupDb.data.repeatedMessages.push({ 
                        text: msgContent, 
                        days: days,
                        expiry: expiry,
                        count: 0, 
                        addedAt: Date.now()
                    });
                    await groupDb.write();
                    await msg.reply(`✅ *MENSAJE AGREGADO*\n📌 *Duración:* ${days === 0 ? 'Permanente' : `${days} día(s)`}`);
                } else {
                    await msg.reply('❌ Uso: Responde a un mensaje con `m addmsg [0-7]`\n(0: permanente, 1-7: días de duración)');
                }
                break;

            case 'msglist':
                if (!isAdmin || !groupDb) break;
                if (groupDb.data.repeatedMessages.length === 0) {
                    await msg.reply('📭 No hay mensajes programados en este grupo.');
                    break;
                }
                let mList = `📋 *MENSAJES DEL TURNO*\n\n`;
                groupDb.data.repeatedMessages.forEach((m, i) => {
                    const dur = m.days === 0 ? 'Permanente' : `Expira en: ${moment(m.expiry).fromNow()}`;
                    mList += `${i + 1}. ${m.text.substring(0, 50)}${m.text.length > 50 ? '...' : ''}\n🕒 *${dur}*\n\n`;
                });
                mList += `_Para eliminar usa: m msgdel [número]_`;
                await msg.reply(mList);
                break;

            case 'msgdel':
                if (!isAdmin || !groupDb) break;
                const idx = parseInt(args[0]) - 1;
                if (isNaN(idx) || !groupDb.data.repeatedMessages[idx]) {
                    await msg.reply('❌ Número de mensaje inválido. Usa `m msglist` para ver los números.');
                    break;
                }
                const deleted = groupDb.data.repeatedMessages.splice(idx, 1);
                await groupDb.write();
                await msg.reply(`🗑️ *Mensaje eliminado:* ${deleted[0].text.substring(0, 30)}...`);
                break;

            case 'open':
                if (isAdmin) { await chat.setMessagesAdminsOnly(false); await msg.reply('🔓 *Grupo ABIERTO.*'); }
                break;

            case 'close':
                if (isAdmin) { await chat.setMessagesAdminsOnly(true); await msg.reply('🔒 *Grupo CERRADO.*'); }
                break;

            case 'ban':
                if (isAdmin && msg.hasQuotedMsg) {
                    const quoted = await msg.getQuotedMessage();
                    await chat.removeParticipant(quoted.author || quoted.from);
                }
                break;

            case 'afk':
                const reasonAfk = args.join(' ') || 'Sin motivo';
                globalDb.data.afk[sender] = { reason: reasonAfk, time: Date.now() };
                await globalDb.write();
                await msg.reply(`*MODO AFK ACTIVADO* 💤\n\n*📝 Motivo:* ${reasonAfk}`);
                break;

            case 'r':
                if (!isAdmin || !groupResponsesDb) break;
                if (!msg.hasQuotedMsg) {
                    await msg.reply('❌ Debes responder a un mensaje para guardarlo como respuesta.');
                    break;
                }
                const triggerR = args.join(' ').toLowerCase();
                if (!triggerR) {
                    await msg.reply('❌ Uso: Responde a un mensaje con `r palabra1, palabra2`');
                    break;
                }
                const quotedRespR = await msg.getQuotedMessage();
                
                if (quotedRespR.hasMedia) {
                    const media = await quotedRespR.downloadMedia();
                    if (media) {
                        const ext = media.mimetype.split('/')[1].split(';')[0];
                        const filename = `${Date.now()}.${ext}`;
                        const filePath = path.join('database', filename);
                        fs.writeFileSync(filePath, media.data, { encoding: 'base64' });
                        
                        groupResponsesDb.data.responses[triggerR] = {
                            type: 'media',
                            filename: filename,
                            caption: quotedRespR.body || ''
                        };
                        await groupResponsesDb.write();
                        await msg.reply(`✅ *IMAGEN GUARDADA (GRUPO)*\n🎯 *Activadores:* ${triggerR}`);
                    }
                } else {
                    groupResponsesDb.data.responses[triggerR] = quotedRespR.body;
                    await groupResponsesDb.write();
                    await msg.reply(`✅ *RESPUESTA GUARDADA (GRUPO)*\n🎯 *Activadores:* ${triggerR}`);
                }
                break;

            case 'rlist':
                if (!isAdmin || !groupResponsesDb) break;
                const keysList = Object.keys(groupResponsesDb.data.responses);
                if (keysList.length === 0) {
                    await msg.reply('📭 No hay respuestas automáticas guardadas en este grupo.');
                    break;
                }

            case 'padd':
                if (!isAdmin) break;
                if (!msg.hasQuotedMsg) {
                    await msg.reply('❌ Responde a un mensaje para guardarlo como plantilla PM.');
                    break;
                }
                const pQuoted = await msg.getQuotedMessage();
                privateDb.data.templates.push({ text: pQuoted.body });
                await privateDb.write();
                await msg.reply(`✅ Plantilla PM agregada (Total: ${privateDb.data.templates.length}).`);
                break;

            case 'plist':
                if (!isAdmin) break;
                if (privateDb.data.templates.length === 0) {
                    await msg.reply('📭 No hay plantillas PM guardadas.');
                    break;
                }
                let pText = `📋 *PLANTILLAS PRIVADAS*\n\n`;
                privateDb.data.templates.forEach((t, i) => {
                    pText += `${i + 1}. ${t.text.substring(0, 50)}...\n\n`;
                });
                await msg.reply(pText);
                break;

            case 'pdel':
                if (!isAdmin) break;
                const pIdx = parseInt(args[0]) - 1;
                if (isNaN(pIdx) || !privateDb.data.templates[pIdx]) {
                    await msg.reply('❌ Número inválido.');
                    break;
                }
                privateDb.data.templates.splice(pIdx, 1);
                await privateDb.write();
                await msg.reply('🗑️ Plantilla eliminada.');
                break;
                let listT = `📋 *LISTA DE RESPUESTAS (GRUPO)*\n\n`;
                keysList.forEach((k, i) => {
                    listT += `${i + 1}. *Activadores:* ${k}\n`;
                });
                listT += `\n_Para eliminar usa: rdel [palabra]_`;
                
                const responseChatRel = await contact.getChat();
                await responseChatRel.sendMessage(listT);
                if (isGroup) await msg.reply('✅ *Lista enviada al privado.*');
                break;

            case 'rdel':
                if (!isAdmin || !groupResponsesDb) break;
                const toDel = args.join(' ').toLowerCase();
                if (!toDel) {
                    await msg.reply('❌ Uso: `rdel [activador exacto]`');
                    break;
                }
                if (groupResponsesDb.data.responses[toDel]) {
                    delete groupResponsesDb.data.responses[toDel];
                    await groupResponsesDb.write();
                    await msg.reply(`🗑️ *Respuesta eliminada:* ${toDel}`);
                } else {
                    await msg.reply('❌ No se encontró esa respuesta en este grupo.');
                }
                break;

            case 'addserv':
                if (!isAdmin) break;
                const sParts = args.join(' ').split('|').map(p => p.trim());
                if (sParts.length < 4) {
                    await msg.reply('❌ Uso: `addserv Nombre | Link | Precio | Espera | [Extra]`');
                    break;
                }
                const [sName, sLink, sPrice, sWait, sExtra] = sParts;
                globalDb.data.services[sName.toLowerCase()] = {
                    link: sLink,
                    price: sPrice,
                    wait: sWait,
                    extra: sExtra || ''
                };
                await globalDb.write();
                await msg.reply(`✅ *SERVICIO AGREGADO:* ${sName.toUpperCase()}`);
                break;
        }
    }

    // Nuevo comando: mutetime sin prefijo
    if (body.toLowerCase().startsWith('mutetime') && isGroup) {
        if (isAdmin && msg.hasQuotedMsg) {
            const argsMute = body.split(' ');
            const timeVal = parseInt(argsMute[1]);
            const timeUnit = argsMute[2]?.toLowerCase() || 'm'; // m por defecto (minutos)
            
            if (isNaN(timeVal)) {
                await msg.reply('❌ Uso: Responde a un mensaje con `mutetime [numero] [m|h]`');
                return;
            }

            let durationMs = timeVal * 60000; // default minutos
            if (timeUnit.startsWith('h')) durationMs = timeVal * 3600000;
            
            const quotedMute = await msg.getQuotedMessage();
            const targetUser = quotedMute.author || quotedMute.from;
            
            db.data.mutedUsers[targetUser] = {
                until: Date.now() + durationMs,
                groupId: chat.id._serialized
            };
            await db.write();
            
            await msg.reply(`🔇 *USUARIO MUTEADO*\n👤 *Usuario:* @${targetUser.split('@')[0]}\n⏳ *Duración:* ${timeVal} ${timeUnit === 'h' ? 'hora(s)' : 'minuto(s)'}\n\n_Sus mensajes serán eliminados automáticamente._`, {
                mentions: [targetUser]
            });
        }
    }
});

function setupScheduler() {
    cron.schedule('* * * * *', async () => {
        const nowStr = moment().format('HH:mm');
        const now = moment();
        
        // El scheduler ahora debe buscar en la carpeta database/groups
        const groupsDir = path.join('database', 'groups');
        if (!fs.existsSync(groupsDir)) return;

        const files = fs.readdirSync(groupsDir);
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            
            try {
                // El nombre del archivo tiene el JID (con _ en vez de caracteres especiales)
                // Pero lo mejor es leer el JID del contenido si lo guardáramos, 
                // o reconstruirlo si es predecible. 
                // Para LowDB JSONFilePreset, cargamos la DB:
                const cleanId = file.replace('.json', '');
                // Reconstruimos el JID (asumiendo que _c.us o _g.us es el final)
                const groupId = cleanId.replace(/_g_us$/, '@g.us').replace(/_c_us$/, '@c.us');
                
                const groupDb = await getGroupDb(groupId);
                const config = groupDb.data;

                if (!config.active) continue;

                const chat = await client.getChatById(groupId);
                if (nowStr === config.openTime) {
                    await chat.setMessagesAdminsOnly(false);
                    await chat.sendMessage(`╔══════════════════╗\n║    ☀️ *¡BUENOS DÍAS!*    ║\n╚══════════════════╝\n\nEl turno ha iniciado. *Grupo ABIERTO.*`);
                    
                    // Limpiar mensajes expirados y resetear conteos
                    const initialCount = config.repeatedMessages.length;
                    config.repeatedMessages = config.repeatedMessages.filter(m => {
                        if (m.days === 0) return true; // Permanente
                        return Date.now() < m.expiry; // Aún no expira
                    });
                    
                    config.repeatedMessages.forEach(m => m.count = 0);
                    await groupDb.write();
                } else if (nowStr === config.closeTime) {
                    await chat.setMessagesAdminsOnly(true);
                    await chat.sendMessage(`╔══════════════════╗\n║    🌙 *¡TURNO CERRADO!*   ║\n╚══════════════════╝\n\nEl turno ha finalizado. *Grupo CERRADO.*`);
                }

                const startTime = moment(config.openTime, 'HH:mm');
                const endTime = moment(config.closeTime, 'HH:mm');
                
                if (now.isBetween(startTime, endTime) || nowStr === config.openTime) {
                    const totalDurationMinutes = endTime.diff(startTime, 'minutes');
                    const interval = Math.floor(totalDurationMinutes / 4); 
                    
                    const sendTimes = [0, interval, interval * 2, interval * 3, totalDurationMinutes - 120].map(mins => 
                        startTime.clone().add(mins, 'minutes').format('HH:mm')
                    );

                    if (sendTimes.includes(nowStr) && config.repeatedMessages) {
                        for (let m of config.repeatedMessages) {
                            if (m.count < 5) {
                                const prefix = nowStr === config.openTime ? '🌟 *BIENVENIDOS:*' : '📢 *RECORDATORIO:*';
                                await chat.sendMessage(`${prefix}\n\n${m.text}`);
                                m.count++;
                                await groupDb.write();
                            }
                        }
                    }
                }
            } catch (e) { /* Silencioso para archivos que no correspondan a chats reales */ }
        }
    });
}

client.initialize();
