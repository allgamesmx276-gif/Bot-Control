import { JSONFilePreset } from 'lowdb/node';
import path from 'path';

const DB_PATH = 'database';

export async function getPrivateMsgsDb() {
    const filePath = path.join(DB_PATH, 'private_messages.json');
    const defaultData = {
        templates: [], // { id, text }
        history: {}    // { targetNumber: { count, lastSent } }
    };
    return await JSONFilePreset(filePath, defaultData);
}
