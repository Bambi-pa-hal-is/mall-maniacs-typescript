// Run with: node --test tests/   (Node 24 strips TypeScript types natively)
// Parses the real game data in ../original (read-only) and checks the decoded structure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseSen, detailLevel } from '../src/formats/sen.ts';
import { parseAnm } from '../src/formats/anm.ts';
import { parseDff } from '../src/formats/dff.ts';
import { parseTpg, tpgToRgba } from '../src/formats/tpg.ts';
import { xor55, decodeText } from '../src/formats/xor.ts';

const ORIGINAL = path.resolve(import.meta.dirname, '../../original');
const read = (rel: string) => {
  const b = fs.readFileSync(path.join(ORIGINAL, rel));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const files = (dir: string, ext: string) =>
  fs.readdirSync(path.join(ORIGINAL, dir)).filter((f) => f.toLowerCase().endsWith(ext)).map((f) => `${dir}/${f}`);

test('maniac.cfg decodes and parses', () => {
  const cfg = parseDff(decodeText(xor55(new Uint8Array(read('maniac.cfg')))));
  const levels = cfg.array('levels');
  assert.equal(levels.length, 5);
  assert.equal(levels[0].str('scene_file'), 'mall1_ica.sen');
  assert.deepEqual(levels[0].array('start_positions')[0].numbers(), [1500, 0, 9500, 0, -32364, 0]);
  assert.deepEqual(levels[0].block('startup').strings(), ['nload ica.ai', 'eload ica.eo']);
  const objects = cfg.block('objects');
  assert.equal(objects.array('characters').length, 10);
  assert.equal(objects.array('carts')[1].str('object_name'), 'GREENCART');
  assert.equal(cfg.block('master').num('obj_update_time'), 40);
  assert.ok(cfg.array('items').length >= 30);
});

test('nav buoys (.ai) and event objects (.eo) parse', () => {
  const ai = parseDff(decodeText(new Uint8Array(read('ica.ai'))));
  assert.ok(ai.children.length > 50);
  const first = ai.children[0][1];
  assert.equal(first.num('ID'), 1);
  assert.equal(first.block('LINKS').all('LINK').length, first.num('NLINKS'));
  const eo = parseDff(decodeText(new Uint8Array(read('ica.eo'))));
  assert.ok(eo.children.length > 0);
  assert.equal(eo.children[0][1].block('values').all('v').length, 5);
});

test('every SEN file decodes with in-range indices', () => {
  const sens = ['menu', 'menu/end', 'scene_aqua', 'scene_future', 'scene_ica', 'scene_orient', 'scene_wood'].flatMap((d) => files(d, '.sen'));
  assert.equal(sens.length, 22);
  for (const f of sens) {
    const s = parseSen(read(f));
    assert.ok(s.meshes.length > 0, f);
    for (const m of s.meshes) {
      const lod = m.lods[0];
      const grouped = lod.vertexGroups.reduce((n, g) => n + g.count, 0);
      assert.ok(grouped === 0 || grouped === lod.vertexCount, `${f} ${m.name} vertex groups`);
      for (const g of lod.primGroups) for (const p of g.prims) {
        for (const i of p.indices) assert.ok(i < lod.vertexCount, `${f} ${m.name} index`);
        if (p.mapi !== null) assert.ok(p.mapi < s.mapi.length, `${f} ${m.name} mapi`);
      }
    }
    for (const o of s.objects) assert.notEqual(o.name, '?', `${f} object name`);
  }
});

test('ICA mall matches the Python reference decoder', () => {
  const s = parseSen(read('scene_ica/MALL1_ICA.SEN'));
  assert.equal(s.meshes.length, 179);
  assert.equal(s.objects.length, 179);
  const prims = s.meshes.reduce((n, m) => n + m.lods[0].primGroups.reduce((k, g) => k + g.prims.length, 0), 0);
  assert.equal(prims, 2851);
  const chars = parseSen(read('scene_ica/CHARACTERS.SEN'));
  const roland = chars.meshes[chars.objects.find((o) => o.name === 'ROLAND')!.mesh];
  assert.equal(roland.nodes.length, 15);
  assert.deepEqual(detailLevel('_2ROLAND'), { base: 'ROLAND', level: 2 });
});

test('every ANM file parses to the end', () => {
  for (const f of files('anim', '.anm')) {
    const a = parseAnm(read(f));
    assert.equal(a.nodes.length, 16, f);
    assert.ok(a.frames.length > 0, f);
  }
  const run = parseAnm(read('anim/s_run.anm'));
  assert.deepEqual(run.frames[0].positions.get(0), [0, 739, 179]);
});

test('nav graphs route from the start to every item spot and the goal in all malls', async () => {
  const { NavGraph } = await import('../src/game/navGraph.ts');
  const { parseEventObjects } = await import('../src/game/events.ts');
  const cfg = parseDff(decodeText(xor55(new Uint8Array(read('maniac.cfg')))));
  for (const level of cfg.array('levels')) {
    const startup = level.block('startup').strings();
    const file = (cmd: string) => startup.find((s) => s.startsWith(cmd))!.split(' ')[1];
    const nav = new NavGraph(parseDff(decodeText(new Uint8Array(read(file('nload'))))));
    const events = parseEventObjects(parseDff(decodeText(new Uint8Array(read(file('eload'))))));
    const [sx, sy, sz] = level.array('start_positions')[0].numbers();
    const start = nav.nearest(sx, sz, sy - 400, sy + 1000)!;
    assert.ok(nav.nodes.length > 50, level.str('scene_file'));
    const goal = events.find((e) => e.name === 'goal');
    assert.ok(goal?.bounds, `${level.str('scene_file')} goal area`);
    const checkpoints = events.filter((e) => e.type >= 201 && e.type < 300).map((e) => e.type).sort((a, b) => a - b);
    assert.ok(checkpoints.length >= 20, `${level.str('scene_file')} checkpoints`);
    assert.deepEqual(checkpoints, checkpoints.map((_, i) => 201 + i), `${level.str('scene_file')} checkpoint numbering`);
    const targets = events.filter((e) => (e.type >= 1 && e.type <= 24) || e.type >= 201 || e.name === 'goal');
    let unreachable = 0;
    for (const t of targets) {
      const dest = nav.nearest(t.x, t.z, t.y - 400, t.y + 1000)!;
      let n = start;
      for (let hops = 0; n !== dest && hops < 500; hops++) {
        const next = nav.nextHop(n, dest);
        if (!next) break;
        n = next;
      }
      if (n !== dest) unreachable++;
    }
    assert.equal(unreachable, 0, `${level.str('scene_file')}: ${unreachable} of ${targets.length} targets unreachable`);
  }
});

test('quest.txt decodes into yes/no questions', async () => {
  const { parseQuiz } = await import('../src/formats/quiz.ts');
  const q = parseQuiz(decodeText(xor55(new Uint8Array(read('quest.txt')))));
  assert.equal(q.filter((x) => x.level === 0).length, 145);
  assert.equal(q.length, 430);
  assert.ok(q[0].text.endsWith('?'));
  assert.ok(q.some((x) => x.answer) && q.some((x) => !x.answer));
});

test('bitmap fonts map glyphs into their atlas', async () => {
  const { parseFont, charCode, textWidth } = await import('../src/formats/font.ts');
  const list = parseFont(new Uint8Array(read('scene_ica/hud/font.txt')));
  // width 10, squeeze -17: 8 cells per row (80 px), 'A' is cell 0, 'a' is cell 29.
  assert.equal(list.u[charCode('A')], 0);
  assert.equal(list.u[charCode('a')], (29 * 10) % 80);
  assert.equal(list.v[charCode('a')], Math.floor(290 / 80) * 12);
  const hud = parseFont(new Uint8Array(read('scene_ica/hud/hudfont.txt')));
  // width 42, 6 per row: '0' is cell 29 -> row 4, column 5.
  assert.equal(hud.u[charCode('0')], 5 * 42);
  assert.equal(hud.v[charCode('0')], 4 * 36);
  assert.equal(hud.u[charCode('Å')], 2 * 42);
  assert.ok(textWidth(hud, '1/8') > 0);
});

test('TPG converts to RGBA', () => {
  const rgba = tpgToRgba(parseTpg(read('scene_ica/MERGED03.TPG')), false);
  assert.equal(rgba.length, 256 * 256 * 4);
  assert.equal(rgba[3], 255);
});
