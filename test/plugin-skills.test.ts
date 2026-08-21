import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 스킬은 두 곳에 산다. `.claude/skills/<name>.md` 는 이 레포에서 작업할 때 읽히고,
// `plugins/tirno/skills/<name>/SKILL.md` 는 마켓플레이스로 설치될 때 읽힌다.
//
// 심링크로 하나만 두려 했는데 깨진다 — GitHub 설치는 플러그인 하위트리만 캐시로
// 가져가므로 레포 루트로 올라가는 링크가 밖을 가리킨다(실측). 그래서 실물 복사를
// 두고, 어긋나면 여기서 깨뜨린다. 사본이 낡는 것이 이 레포에서 가장 자주 난 결함이다.

const ROOT = path.join(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, '.claude', 'skills');
const PLUGIN = path.join(ROOT, 'plugins', 'tirno', 'skills');

const names = fs.readdirSync(SRC).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));

test('모든 스킬이 플러그인에 실려 있다', () => {
  assert.ok(names.length > 0, `${SRC} 에 스킬이 없다`);
  const shipped = fs.readdirSync(PLUGIN).sort();
  assert.deepEqual(shipped, [...names].sort(),
    '플러그인의 스킬 목록이 .claude/skills 와 다르다');
});

// 심링크로 두면 GitHub 설치에서 깨진다 — 플러그인 하위트리만 캐시로 가므로 레포 루트로
// 올라가는 링크가 밖을 가리킨다. 실물 파일이어야 한다.
test('플러그인 사본이 심링크가 아니다', () => {
  for (const n of names) {
    const st = fs.lstatSync(path.join(PLUGIN, n, 'SKILL.md'));
    assert.ok(!st.isSymbolicLink(),
      `${n}: SKILL.md 가 심링크다 — GitHub 설치에서 깨진다. 실물로 복사할 것`);
  }
});

test('플러그인 사본이 원본과 같다', () => {
  for (const n of names) {
    const src = fs.readFileSync(path.join(SRC, `${n}.md`), 'utf-8');
    const copy = fs.readFileSync(path.join(PLUGIN, n, 'SKILL.md'), 'utf-8');
    assert.equal(copy, src,
      `${n}: 사본이 낡았다 — cp .claude/skills/${n}.md plugins/tirno/skills/${n}/SKILL.md`);
  }
});

// description 이 없으면 스킬 선택에 걸리지 않는다 — 있어도 안 불리는 스킬이 된다.
test('모든 스킬에 description frontmatter 가 있다', () => {
  for (const n of names) {
    const s = fs.readFileSync(path.join(SRC, `${n}.md`), 'utf-8');
    assert.ok(s.startsWith('---\n'), `${n}: frontmatter 가 없다`);
    const fm = s.slice(4, s.indexOf('\n---', 4));
    assert.match(fm, /^description:\s*\S/m, `${n}: description 이 비었다`);
  }
});

// 스킬이 부르는 스크립트가 플러그인 안에 실려야 한다 — 레포 경로를 가리키면 설치본에 없다.
test('스킬이 부르는 스크립트가 플러그인에 실려 있다', () => {
  const gen = path.join(PLUGIN, 'tirno-sw-override', 'scripts', 'generate.mjs');
  assert.ok(fs.existsSync(gen), 'sw-proxy 생성기가 스킬 안에 없다');
  assert.ok(fs.existsSync(path.join(path.dirname(gen), 'sw-template.js')), 'sw-template 이 없다');
});

// 마켓플레이스가 가리키는 곳에 플러그인이 실제로 있어야 한다.
test('marketplace.json 이 실재하는 플러그인을 가리킨다', () => {
  const mp = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf-8'));
  assert.ok(Array.isArray(mp.plugins) && mp.plugins.length > 0);
  for (const p of mp.plugins) {
    const dir = path.join(ROOT, p.source);
    assert.ok(fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json')),
      `${p.name}: ${p.source} 에 plugin.json 이 없다`);
  }
});

// 버전이 세 곳에 산다 — package.json · src/main.ts 의 .version() · 플러그인 매니페스트.
// 릴리즈 태그가 바이너리의 --version 과 다르면 받은 사람이 무엇을 쥔 건지 알 수 없다.
test('버전이 세 곳에서 같다', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.ts'), 'utf-8');
  const cli = /\.version\('([^']+)'\)/.exec(main)?.[1];
  const plug = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'plugins', 'tirno', '.claude-plugin', 'plugin.json'), 'utf-8')).version;
  assert.equal(cli, pkg, `src/main.ts 의 .version() 이 package.json 과 다르다`);
  assert.equal(plug, pkg, `플러그인 매니페스트가 package.json 과 다르다`);
});
