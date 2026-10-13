/**
 * Criptografia da senha em repouso (paridade com o ENCRYPT_LOCAL_SESSION do ali-coins).
 *
 * Modelo: uma chave AES-256-GCM NÃO-exportável é gerada uma única vez e guardada no
 * IndexedDB da extensão (origem chrome-extension://<id>, inacessível a páginas web).
 * A senha é cifrada com essa chave antes de ir para chrome.storage.local, de modo que
 * um dump do storage (ou a UI de inspeção) não exponha a senha em texto puro.
 *
 * Observação honesta: isso eleva o custo de vazamento casual, mas o limite de confiança
 * continua sendo o perfil do Chrome do usuário. Recomenda-se perfil dedicado.
 */

const DB_NAME = 'ali-coins-chrome';
const DB_VERSION = 1;
const STORE = 'crypto';
const MASTER_KEY_ID = 'master-key';

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Falha ao abrir IndexedDB.'));
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Obtém (ou cria) a chave mestra AES-GCM não-exportável.
 * @returns {Promise<CryptoKey>}
 */
async function getMasterKey() {
  const db = await openDb();
  try {
    let key = await idbGet(db, MASTER_KEY_ID);
    if (key && key.type === 'secret') return key;

    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt'
    ]);
    await idbPut(db, MASTER_KEY_ID, key);
    return key;
  } finally {
    db.close();
  }
}

function toB64(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

function fromB64(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  return arr;
}

/**
 * Cifra um texto. Retorna null se o WebCrypto/IndexedDB não estiver disponível.
 * @param {string} plain
 * @returns {Promise<{v: number, iv: string, ct: string} | null>}
 */
export async function encryptText(plain) {
  if (!plain) return null;
  try {
    const key = await getMasterKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(plain);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return { v: 1, iv: toB64(iv), ct: toB64(cipher) };
  } catch {
    return null;
  }
}

/**
 * Decifra um payload criado por encryptText.
 * @param {{v: number, iv: string, ct: string} | null | undefined} payload
 * @returns {Promise<string | null>}
 */
export async function decryptText(payload) {
  if (!payload || typeof payload !== 'object' || !payload.iv || !payload.ct) return null;
  try {
    const key = await getMasterKey();
    const iv = fromB64(payload.iv);
    const data = fromB64(payload.ct);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(plainBuf);
  } catch {
    return null;
  }
}
