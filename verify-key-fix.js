'use strict';
/* 验证：部分更新设置时 AI 密钥不再被清空 */
const BASE = 'http://127.0.0.1:3000';
const H = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)' };
const put = body => fetch(BASE + '/api/settings', { method: 'PUT', headers: H, body: JSON.stringify(body) }).then(r => r.json());
const get = () => fetch(BASE + '/api/settings').then(r => r.json());

(async () => {
  // 1. 完整保存（含密钥）
  await put({ aiProvider: 'deepseek', aiBaseUrl: 'https://api.deepseek.com', aiKey: 'sk-测试保留密钥', aiModel: 'deepseek-chat' });
  // 2. 部分更新（只改 provider，不带 aiKey）
  await put({ aiProvider: 'demo' });
  const s1 = await get();
  console.log('部分更新后密钥保留:', s1.aiKey === 'sk-测试保留密钥' ? '✅ 是（修复生效）' : '❌ 被清空');

  // 3. 切回 deepseek，验证密钥仍在
  await put({ aiProvider: 'deepseek' });
  const s2 = await get();
  console.log('切换provider后密钥:', s2.aiKey === 'sk-测试保留密钥' ? '✅ 在' : '❌ 丢');

  // 4. 清理假密钥，恢复演示模式（真实密钥需要用户在界面重新填写）
  await put({ aiProvider: 'demo', aiKey: '' });
  const s3 = await get();
  console.log('最终状态: provider=' + s3.aiProvider + ', 密钥已清空=' + (s3.aiKey === ''));
  console.log('测试完成：请到 系统设置→AI助手配置 重新粘贴你的真实密钥');
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
