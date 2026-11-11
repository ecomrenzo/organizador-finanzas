import { ConfigError } from './errors.js';

let cachedDb = null;

export function normalizePrivateKey(raw) {
  if (typeof raw !== 'string') return '';
  let key = raw.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, '\n').trim();
}

export function readFirebaseConfig(env = process.env) {
  const projectId = (env.FIREBASE_PROJECT_ID || '').trim();
  if (!projectId) throw new ConfigError('Missing FIREBASE_PROJECT_ID');

  if ((env.FIRESTORE_EMULATOR_HOST || '').trim()) {
    return { mode: 'emulator', projectId };
  }

  const clientEmail = (env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = normalizePrivateKey(env.FIREBASE_PRIVATE_KEY);
  if (!clientEmail || !privateKey) {
    throw new ConfigError('Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY');
  }
  if (!clientEmail.includes('@') || !clientEmail.endsWith('.iam.gserviceaccount.com')) {
    throw new ConfigError('FIREBASE_CLIENT_EMAIL is not a service account email');
  }
  if (!/BEGIN (?:RSA )?PRIVATE KEY/.test(privateKey) || !/END (?:RSA )?PRIVATE KEY/.test(privateKey)) {
    throw new ConfigError('FIREBASE_PRIVATE_KEY is not a PEM private key');
  }
  return { mode: 'cert', projectId, clientEmail, privateKey };
}

export async function getDb() {
  if (cachedDb) return cachedDb;
  const config = readFirebaseConfig();
  const { getApps, initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');

  const existing = getApps()[0];
  const app = existing || initializeApp(
    config.mode === 'emulator'
      ? { projectId: config.projectId }
      : {
          credential: cert({
            projectId: config.projectId,
            clientEmail: config.clientEmail,
            privateKey: config.privateKey,
          }),
        },
  );
  cachedDb = getFirestore(app);
  return cachedDb;
}
