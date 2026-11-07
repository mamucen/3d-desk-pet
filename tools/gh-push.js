/**
 * 通过 GitHub REST API 提交代码（绕过 github.com 被墙、git push 不可用的问题）
 * 用法：GH_TOKEN=xxx node tools/gh-push.js "commit message"
 * 原理：git ls-files 取文件 → 算 blob sha → 与远程 tree 对比 → 只上传变化文件
 *      → 建新 tree → 建 commit → 移动分支引用
 */
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = process.env.GH_REPO || 'mamucen/3d-desk-pet';
const BRANCH = process.env.GH_BRANCH || 'main';
const TOKEN = process.env.GH_TOKEN;
const MESSAGE = process.argv[2] || '更新项目文件';

if (!TOKEN) {
  console.error('缺少 GH_TOKEN 环境变量');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');

function api(method, urlPath, body) {
  const args = [
    '-sS', '--max-time', '120',
    '-X', method,
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
  ];
  let tmp = null;
  if (body !== undefined) {
    tmp = path.join(os.tmpdir(), 'gh-body-' + process.pid + '-' + Date.now() + '.json');
    fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
    args.push('-H', 'Content-Type: application/json', '--data-binary', '@' + tmp);
  }
  args.push('https://api.github.com' + urlPath);
  let out;
  try {
    out = execFileSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
  }
  if (!out || !out.trim()) return null;
  let parsed;
  try { parsed = JSON.parse(out); } catch { throw new Error('非 JSON 响应: ' + out.slice(0, 300)); }
  if (parsed && parsed.message && !parsed.sha && !parsed.tree && !parsed.object) {
    throw new Error(`${method} ${urlPath} 失败: ${parsed.message}`);
  }
  return parsed;
}

function gitBlobSha(buf) {
  const h = crypto.createHash('sha1');
  h.update(`blob ${buf.length}\u0000`);
  h.update(buf);
  return h.digest('hex');
}

function run() {
  console.log('==> 读取本地文件列表');
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  const files = listed.split('\u0000').filter(Boolean);
  console.log(`    ${files.length} 个文件`);

  console.log('==> 获取远程分支与基线 tree');
  const ref = api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const baseCommitSha = ref.object.sha;
  const baseCommit = api('GET', `/repos/${REPO}/git/commits/${baseCommitSha}`);
  const baseTreeSha = baseCommit.tree.sha;
  console.log(`    基线 commit: ${baseCommitSha.slice(0, 8)}`);

  const remoteTree = api('GET', `/repos/${REPO}/git/trees/${baseTreeSha}?recursive=1`);
  const remoteMap = new Map();
  for (const item of remoteTree.tree || []) {
    if (item.type === 'blob') remoteMap.set(item.path, item.sha);
  }

  console.log('==> 计算差异');
  const entries = [];
  let changed = 0, unchanged = 0, removed = 0;
  for (const rel of files) {
    const abs = path.join(root, rel);
    const buf = fs.readFileSync(abs);
    const sha = gitBlobSha(buf);
    const posix = rel.split(path.sep).join('/');
    const remoteSha = remoteMap.get(posix);
    if (remoteSha === sha) { unchanged++; continue; }
    const blob = api('POST', `/repos/${REPO}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' });
    entries.push({ path: posix, mode: '100644', type: 'blob', sha: blob.sha });
    changed++;
    process.stdout.write(`\r    已上传 ${changed} 个`);
  }
  process.stdout.write('\n');

  // 默认不删除远程文件（避免本地缺少某文件时误删线上内容）
  // 需要镜像式同步时才设置 GH_PRUNE=1
  const localSet = new Set(files.map((r) => r.split(path.sep).join('/')));
  if (process.env.GH_PRUNE === '1') {
    for (const p of remoteMap.keys()) {
      if (!localSet.has(p)) { entries.push({ path: p, mode: '100644', type: 'blob', sha: null }); removed++; }
    }
  }

  console.log(`    新增/修改 ${changed}，未变 ${unchanged}，删除 ${removed}`);

  if (entries.length === 0) {
    console.log('没有需要提交的改动。');
    return;
  }

  console.log('==> 创建 tree 与 commit');
  const newTree = api('POST', `/repos/${REPO}/git/trees`, { base_tree: baseTreeSha, tree: entries });
  const newCommit = api('POST', `/repos/${REPO}/git/commits`, {
    message: MESSAGE,
    tree: newTree.sha,
    parents: [baseCommitSha],
  });
  console.log(`    新 commit: ${newCommit.sha.slice(0, 8)}`);

  console.log('==> 更新分支引用');
  api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: newCommit.sha, force: false });

  console.log('');
  console.log('完成: https://github.com/' + REPO);
  console.log('commit: ' + newCommit.sha);
}

try { run(); } catch (err) {
  console.error('\n[失败] ' + err.message);
  process.exit(1);
}
