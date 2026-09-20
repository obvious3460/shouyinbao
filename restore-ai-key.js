'use strict';
/* 从种子备份中静默恢复 AI 密钥（不打印密钥内容） */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const backups = fs.readdirSync(path.join(__dirname, 'backup')).filter(f => f.startsWith('模拟数据前备份')).sort();
const backup = backups.pop();
if (!backup){ console.log('未找到备份'); process.exit(1); }

const bdb = new DatabaseSync(path.join(__dirname, 'backup', backup), { readOnly: true });
const row = bdb.prepare("SELECT value FROM settings WHERE key='aiKey'").get();
bdb.close();

if (!row || !row.value){ console.log('备份中也没有密钥，需要你在界面重新填写'); process.exit(0); }

const live = new DatabaseSync(path.join(__dirname, 'data', 'shouyinbao.db'));
live.prepare("INSERT INTO settings (key, value) VALUES ('aiKey', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(row.value);
live.close();
console.log('✅ 已从备份恢复 AI 密钥（不显示内容，长度 ' + row.value.length + ' 字符）');
