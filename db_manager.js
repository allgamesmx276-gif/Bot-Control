import { JSONFilePreset } from 'lowdb/node';
import path from 'path';
import fs from 'fs';

const DB_PATH = 'database';

export async function getGroupDb(groupId) {
    const cleanId = groupId.replace(/[^a-zA-Z0-9]/g, '_');
    const filePath = path.join(DB_PATH, 'groups', `${cleanId}.json`);
    
    const defaultData = {
        openTime: '08:00',
        closeTime: '20:00',
        active: false,
        repeatedMessages: []
    };

    return await JSONFilePreset(filePath, defaultData);
}

export async function getResponsesDb(groupId) {
    const cleanId = groupId.replace(/[^a-zA-Z0-9]/g, '_');
    const filePath = path.join(DB_PATH, 'responses', `${cleanId}.json`);
    
    const defaultData = {
        responses: {} // { trigger: response_data }
    };

    return await JSONFilePreset(filePath, defaultData);
}

// Para configuraciones globales (warns, afk, muted)
const globalDefault = { 
  warns: {}, 
  afk: {}, 
  mutedUsers: {},
  services: {}
};
const globalDb = await JSONFilePreset(path.join(DB_PATH, 'global.json'), globalDefault);
export { globalDb };
