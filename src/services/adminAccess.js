const config = require('../config');
const { BotAdmin } = require('../db');

const runtimeAdminIds = new Set([...config.admins].map(Number).filter(Number.isFinite));
let loaded = false;

function normalizeTelegramId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{5,20}$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function primaryAdminId() {
  const first = [...config.admins][0];
  return Number.isFinite(Number(first)) ? Number(first) : null;
}

function isAdmin(value) {
  const id = normalizeTelegramId(value);
  return id !== null && runtimeAdminIds.has(id);
}

function getAdminIds() {
  return [...runtimeAdminIds].sort((a, b) => a - b);
}

async function loadAdmins() {
  const primary = primaryAdminId();
  for (const id of config.admins) {
    const numericId = Number(id);
    const [row] = await BotAdmin.findOrCreate({
      where: { telegramId: numericId },
      defaults: {
        telegramId: numericId,
        isActive: true,
        isProtected: numericId === primary,
        source: 'environment',
        permissions: { full: true }
      }
    });
    if (numericId === primary && (!row.isActive || !row.isProtected)) {
      await row.update({ isActive: true, isProtected: true, permissions: { full: true } });
    }
  }

  runtimeAdminIds.clear();
  const rows = await BotAdmin.findAll({ where: { isActive: true }, order: [['createdAt', 'ASC']] });
  for (const row of rows) {
    const id = normalizeTelegramId(row.telegramId);
    if (id !== null) runtimeAdminIds.add(id);
  }
  if (primary !== null) runtimeAdminIds.add(primary);
  loaded = true;
  return getAdminIds();
}

async function listAdmins() {
  if (!loaded) await loadAdmins();
  return BotAdmin.findAll({ order: [['isProtected', 'DESC'], ['createdAt', 'ASC']] });
}

async function addAdmin(telegramId, actor = null, displayName = '') {
  const id = normalizeTelegramId(telegramId);
  if (id === null) throw new Error('INVALID_TELEGRAM_ID');
  const actorId = normalizeTelegramId(actor?.id ?? actor);
  const [row] = await BotAdmin.findOrCreate({
    where: { telegramId: id },
    defaults: {
      telegramId: id,
      isActive: true,
      isProtected: id === primaryAdminId(),
      source: 'telegram',
      addedByTelegramId: actorId,
      displayName: String(displayName || '').slice(0, 160) || null,
      permissions: { full: true }
    }
  });
  const changes = {
    isActive: true,
    permissions: { full: true },
    addedByTelegramId: actorId || row.addedByTelegramId || null
  };
  if (displayName) changes.displayName = String(displayName).slice(0, 160);
  if (id === primaryAdminId()) changes.isProtected = true;
  await row.update(changes);
  runtimeAdminIds.add(id);
  return row;
}

async function removeAdmin(telegramId, actor = null) {
  const id = normalizeTelegramId(telegramId);
  if (id === null) throw new Error('INVALID_TELEGRAM_ID');
  const row = await BotAdmin.findByPk(id);
  if (!row) throw new Error('ADMIN_NOT_FOUND');
  if (row.isProtected || id === primaryAdminId()) throw new Error('PROTECTED_ADMIN');
  if (getAdminIds().length <= 1) throw new Error('LAST_ADMIN');
  const actorId = normalizeTelegramId(actor?.id ?? actor);
  await row.update({ isActive: false, removedByTelegramId: actorId, removedAt: new Date() });
  runtimeAdminIds.delete(id);
  return row;
}

module.exports = {
  normalizeTelegramId,
  primaryAdminId,
  isAdmin,
  getAdminIds,
  loadAdmins,
  listAdmins,
  addAdmin,
  removeAdmin
};
