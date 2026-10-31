import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { DSHBridgeConfig } from '../dsh/config';
import { validPersonaId } from '../companion/personas';
export type Appearance = { id: string; personaId: string; name: string; parentId: string; primary: boolean; createdAt: number };
export class AppearanceStore {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      'PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS appearances (id TEXT PRIMARY KEY, persona TEXT NOT NULL, payload TEXT NOT NULL, image BLOB NOT NULL)'
    );
  }
  list(personaId?: string): Appearance[] {
    return (
      personaId ? this.db.prepare('SELECT payload FROM appearances WHERE persona=?').all(personaId) : this.db.prepare('SELECT payload FROM appearances').all()
    )
      .map(row => JSON.parse(String(row.payload)) as Appearance)
      .sort((a, b) => Number(b.primary) - Number(a.primary) || b.createdAt - a.createdAt);
  }
  read(id: string, personaId?: string) {
    const row = this.db.prepare('SELECT payload,image FROM appearances WHERE id=?').get(id);

    if (!row) throw new Error('形象不存在');
    const item = JSON.parse(String(row.payload)) as Appearance;

    if (personaId && item.personaId !== personaId) throw new Error('形象不属于当前人设');

    return { item, data: Buffer.from(row.image as Uint8Array) };
  }
  async add(personaId: string, name: string, data: Buffer, parentId = '') {
    if (!validPersonaId(personaId) || typeof name !== 'string' || !name.trim() || name.length > 80 || data.length > 5 * 1024 * 1024)
      throw new Error('形象内容无效，图片最多5MB');
    const metadata = await sharp(data, { limitInputPixels: 16000000 }).metadata();

    if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1) throw new Error('只接受静态PNG、JPEG、WebP');
    const image = await sharp(data, { limitInputPixels: 16000000 }).rotate().png().toBuffer();

    if (image.length > 8 * 1024 * 1024) throw new Error('转换后的图片过大');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (parentId) this.read(parentId, personaId);
      if (this.list(personaId).length >= 100) throw new Error('每个人设最多100张形象');
      const item: Appearance = { id: randomUUID(), personaId, name: name.trim(), parentId, primary: !this.list(personaId).length, createdAt: Date.now() };

      this.db.prepare('INSERT INTO appearances VALUES(?,?,?,?)').run(item.id, personaId, JSON.stringify(item), image);
      this.db.exec('COMMIT');

      return item;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  edit(id: string, action: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { item } = this.read(id);

      if (action === 'primary') {
        for (const row of this.list(item.personaId)) {
          row.primary = row.id === id;
          this.db.prepare('UPDATE appearances SET payload=? WHERE id=?').run(JSON.stringify(row), row.id);
        }
      } else if (action === 'delete') {
        if (this.list(item.personaId).some(row => row.parentId === id)) throw new Error('请先删除该形象的二创版本');
        this.db.prepare('DELETE FROM appearances WHERE id=?').run(id);
        if (item.primary) {
          const next = this.list(item.personaId)[0];

          if (next) {
            next.primary = true;
            this.db.prepare('UPDATE appearances SET payload=? WHERE id=?').run(JSON.stringify(next), next.id);
          }
        }
      } else throw new Error('操作无效');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
const stores = new Map<string, AppearanceStore>();

export const getAppearanceStore = (config: DSHBridgeConfig) => {
  const path = join(dirname(config.workspaceRoot), 'appearances.sqlite');

  if (!stores.has(path)) stores.set(path, new AppearanceStore(path));

  return stores.get(path);
};
