import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:process';

const execFileAsync = promisify(execFile);
const service = 'alemonjs-agent-link';
const account = 'dsh-model-credentials';
let cachedCredentials: DSHCredentials | null | undefined;

const swiftLoad = `
import Foundation
import Security
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: CommandLine.arguments[1],
  kSecAttrAccount as String: CommandLine.arguments[2],
  kSecReturnData as String: true,
  kSecMatchLimit as String: kSecMatchLimitOne
]
var result: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &result)
if status == errSecItemNotFound { exit(2) }
guard status == errSecSuccess, let data = result as? Data else { exit(1) }
FileHandle.standardOutput.write(data)
`;

const swiftSave = `
import Foundation
import Security
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: CommandLine.arguments[1],
  kSecAttrAccount as String: CommandLine.arguments[2]
]
let data = FileHandle.standardInput.readDataToEndOfFile()
let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
if status == errSecItemNotFound {
  var item = query
  item[kSecValueData as String] = data
  if SecItemAdd(item as CFDictionary, nil) != errSecSuccess { exit(1) }
} else if status != errSecSuccess { exit(1) }
`;

const swiftRemove = `
import Foundation
import Security
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: CommandLine.arguments[1],
  kSecAttrAccount as String: CommandLine.arguments[2]
]
let status = SecItemDelete(query as CFDictionary)
if status != errSecSuccess && status != errSecItemNotFound { exit(1) }
`;

export type DSHCredentials = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
};

const encode = (credentials: DSHCredentials): string => JSON.stringify(credentials);

const decode = (value: string): DSHCredentials | null => {
  try {
    const parsed = JSON.parse(value) as Partial<DSHCredentials>;

    return typeof parsed.apiKey === 'string' && parsed.apiKey.trim()
      ? {
          apiKey: parsed.apiKey,
          baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
          model: typeof parsed.model === 'string' ? parsed.model : undefined
        }
      : null;
  } catch {
    return null;
  }
};

const requireKeychain = (): void => {
  if (platform !== 'darwin') {
    throw new Error('当前系统未配置受支持的系统密钥库。');
  }
};

const runSwiftWithSecret = (script: string, secret?: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/swift', ['-e', script, service, account], {
      stdio: ['pipe', 'ignore', 'pipe']
    });
    let stderr = '';

    child.stderr?.on('data', data => {
      stderr += String(data);
    });
    child.once('error', () => reject(new Error('系统密钥库不可用。')));
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error(stderr.trim() || '系统密钥库操作失败。'))));
    child.stdin?.end(secret);
  });

export const getDSHCredentials = async (): Promise<DSHCredentials | null> => {
  requireKeychain();

  if (cachedCredentials !== undefined) {
    return cachedCredentials;
  }

  try {
    const { stdout } = await execFileAsync('/usr/bin/swift', ['-e', swiftLoad, service, account]);

    cachedCredentials = decode(stdout.trim());

    return cachedCredentials;
  } catch {
    cachedCredentials = null;

    return null;
  }
};

export const saveDSHCredentials = async (credentials: DSHCredentials): Promise<void> => {
  requireKeychain();

  if (!credentials.apiKey.trim()) {
    throw new Error('API Key 不能为空。');
  }

  await runSwiftWithSecret(swiftSave, encode(credentials));
  cachedCredentials = { ...credentials };
};

export const removeDSHCredentials = async (): Promise<void> => {
  requireKeychain();

  await runSwiftWithSecret(swiftRemove);
  cachedCredentials = null;
};
