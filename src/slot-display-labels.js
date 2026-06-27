const fs = require('fs');
const path = require('path');

/** AMS account names keyed by engine slot (fallback when WA push name is missing). */
class SlotDisplayLabelStore {
  constructor(appRoot) {
    this.appRoot = appRoot || process.cwd();
    this.filePath = path.join(this.appRoot, 'data', 'slot-display-labels.json');
    this.labels = {};
    this.load();
  }

  ensureDir() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  load() {
    this.labels = {};
    if (!fs.existsSync(this.filePath)) return;
    try {
      this.labels = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) || {};
    } catch {
      this.labels = {};
    }
  }

  save() {
    this.ensureDir();
    fs.writeFileSync(this.filePath, JSON.stringify(this.labels, null, 2), 'utf8');
  }

  get(slot) {
    const row = this.labels[String(slot)];
    return row?.accountName?.trim() || null;
  }

  getRow(slot) {
    return this.labels[String(slot)] || null;
  }

  set(slot, accountName, extra = {}) {
    const name = String(accountName || '').trim();
    if (!name) return null;
    this.labels[String(slot)] = {
      accountName: name,
      phone: extra.phone || null,
      siteKey: extra.siteKey || null,
      location: extra.location || null,
      ipAddress: extra.ipAddress || null,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.labels[String(slot)];
  }

  clearAll() {
    this.labels = {};
    this.save();
  }

  clearSlot(slot) {
    delete this.labels[String(slot)];
    this.save();
  }
}

function readSlotDisplayLabel(appRoot, slot) {
  try {
    const store = new SlotDisplayLabelStore(appRoot);
    return store.get(slot);
  } catch {
    return null;
  }
}

module.exports = {
  SlotDisplayLabelStore,
  readSlotDisplayLabel,
};
