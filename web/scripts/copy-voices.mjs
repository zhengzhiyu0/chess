// One source of truth: the approved, already baked recordings. No generation/API calls here.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '..', 'ChessCoachResources');
const lia = JSON.parse(readFileSync(join(source, 'coach_lines.json'), 'utf8'));
const cast = JSON.parse(readFileSync(join(source, 'Cast', 'coach_lines.json'), 'utf8'));
const roles = [{ id: 'lia', name: '莉亚', coachIndex: 0 }, ...cast.roles.map(({ id, name, coachIndex }) => ({ id, name, coachIndex }))];
if (roles.length !== 8 || new Set(roles.map(r => r.id)).size !== 8 || roles.some((r, i) => r.coachIndex !== i)) throw new Error('Expected the eight game portraits in order');

const playerCategories = new Set(['opening_book_entry', 'opening_book_exit', 'player_accurate', 'player_best', 'player_brilliant', 'player_loses_minor', 'player_loses_rook', 'player_loses_queen', 'player_check', 'tactic_zwischenzug', 'tactic_sacrifice', 'missed_mate', 'blunder_into_mate', 'queen_early', 'defense_found', 'player_missed_tactic', 'comeback']);
const sharedCategories = new Set(['tactic_fork', 'tactic_pin', 'tactic_discovered_attack', 'castling', 'promotion', 'mate']);
function eligibility(role, category, number) {
  let actors = playerCategories.has(category) ? ['player'] : sharedCategories.has(category) ? ['player', 'opponent'] : ['opponent'];
  let pieces;
  if (role === 'lia') {
    if (category === 'mate') actors = number === 4 ? ['player'] : ['opponent'];
    if (category === 'tactic_fork') {
      actors = number === 3 ? ['player'] : number === 2 ? ['player', 'opponent'] : ['opponent'];
      if (number === 2 || number === 3) pieces = ['n'];
    }
    if (category === 'tactic_pin') actors = number === 4 ? ['player'] : ['opponent'];
    if (category === 'tactic_discovered_attack' && number === 1) actors = ['player'];
  }
  if (role === 'xiaoyou' && category === 'mate' && number === 3) actors = ['opponent'];
  if (role === 'ajian' && category === 'tactic_discovered_attack' && number === 2) actors = ['player'];
  return { actors, ...(pieces ? { pieces } : {}) };
}

const catalog = roles.flatMap(role => {
  const clips = role.id === 'lia' ? lia.clips : cast.clips.filter(c => c.role === role.id);
  if (clips.length !== 121 || new Set(clips.map(c => c.category)).size !== 30) throw new Error(`Incomplete role: ${role.id}`);
  const destination = join(root, 'public', 'voices', role.id);
  mkdirSync(destination, { recursive: true });
  const entries = clips.map(({ id, category, text, file }) => {
    if (file !== `${id}.m4a` || !id.startsWith(`${role.id}_`) || !/^[a-z_]+_\d{2}$/.test(id)) throw new Error(`Invalid clip: ${id}`);
    const src = role.id === 'lia' ? join(source, 'Audio', file) : join(source, 'Cast', 'Audio', role.id, file);
    copyFileSync(src, join(destination, file));
    return { id, role: role.id, coachIndex: role.coachIndex, category, text, file, ...eligibility(role.id, category, Number(id.slice(-2))) };
  });
  writeFileSync(join(destination, 'catalog.json'), JSON.stringify(entries, null, 2) + '\n');
  return entries;
});
if (catalog.length !== 968 || new Set(catalog.map(c => c.id)).size !== 968) throw new Error('Expected 968 distinct coach clips');
const json = JSON.stringify(catalog, null, 2) + '\n';
mkdirSync(join(root, 'src', 'coach-voice'), { recursive: true });
writeFileSync(join(root, 'src', 'coach-voice', 'lines.json'), json);
writeFileSync(join(root, 'src', 'coach-voice', 'roles.json'), JSON.stringify(roles, null, 2) + '\n');
writeFileSync(join(root, 'public', 'voices', 'catalog.json'), json);
console.log(`Coaches: ${roles.length} characters, ${catalog.length} bundled recordings`);
