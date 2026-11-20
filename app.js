'use strict';

/* ============================================================
 * 提词器 · 纯前端实现
 * 文稿格式（本地保存）：{ format, version, blocks: [{ type, html, align? }] }
 * 导入可识别：该格式 / Quill Delta / ProseMirror doc / 通用 blocks 数组 / HTML / 纯文本
 * ============================================================ */

const $ = (id) => document.getElementById(id);
const LS = { script: 'teleprompter.script.v1', settings: 'teleprompter.settings.v1' };

const state = {
  blocks: [],
  offset: 0,
  maxOffset: 0,
  playing: false,
  speed: 70,          // px / 秒
  fontSize: 32,
  mirror: false,
  theme: 'dark',
  dragging: false,
  editing: false,
  lastTs: 0,
  charCount: 0,
};

const viewport = $('viewport');
const track = $('track');
const script = $('script');
const stage = $('stage');
const progressFill = $('progressFill');
const statusText = $('statusText');
const posText = $('posText');
const btnPlay = $('btnPlay');
const btnEdit = $('btnEdit');
const speedRange = $('speedRange');
const speedValue = $('speedValue');
const fontValue = $('fontValue');
const fileInput = $('fileInput');
const pasteModal = $('pasteModal');
const pasteArea = $('pasteArea');
const toastEl = $('toast');

const sampleBlocks = [
  { type: 'h1', html: '欢迎使用网页提词器' },
  { type: 'p', html: '这是一份<strong>示例文稿</strong>，所有内容都<em>保存在本地浏览器</em>，不会上传到任何服务器。' },
  { type: 'p', html: '按 <code>空格</code> 开始或暂停，用 <span style="color: #ff8a65">滚轮</span> 或 <span style="color: #7fd1ff">拖拽</span> 手动滑动文稿。' },
  { type: 'h2', html: '基本操作' },
  { type: 'li', html: '<strong>播放 / 暂停</strong>：空格键，或点击底部播放按钮' },
  { type: 'li', html: '<strong>加速 / 减速</strong>：+ / - 键，或拖动速度滑块' },
  { type: 'li', html: '<strong>回到开头</strong>：Home 键' },
  { type: 'li', html: '<strong>手动滑动</strong>：直接在文稿上滚轮或按住拖拽，会自动暂停' },
  { type: 'quote', html: '把你的富文本 JSON 粘贴进来，就可以开始提词了。' },
  { type: 'p', html: '需要镜像翻转时，点击底部「镜像」按钮；字号、速度等设置会自动记住。' },
];

/* ============================================================
 * 富文本解析与安全清洗
 * ============================================================ */

const ALLOWED_INLINE = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'br', 'span',
  'a', 'code', 'mark', 'small', 'sub', 'sup',
]);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function sanitizeStyle(style) {
  return String(style || '').split(';').map((rule) => {
    const idx = rule.indexOf(':');
    if (idx < 0) return '';
    const key = rule.slice(0, idx).trim().toLowerCase();
    const val = rule.slice(idx + 1).trim().toLowerCase();
    if (!['color', 'background-color', 'font-size', 'font-weight'].includes(key)) return '';
    const okColor = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d\s,.]+\))$/.test(val);
    const okSize = /^[\d.]+(px|em|rem|%)$/.test(val);
    const okWeight = /^\d{3}$/.test(val);
    if (!(okColor || (key === 'font-size' && okSize) || (key === 'font-weight' && okWeight))) return '';
    return key + ': ' + escapeHtml(val);
  }).filter(Boolean).join('; ');
}

function cleanNode(node) {
  if (node.nodeType === 3) return escapeHtml(node.textContent);
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'svg') return '';
  const kids = Array.from(node.childNodes).map(cleanNode).join('');
  if (!ALLOWED_INLINE.has(tag)) return kids;           // 未知标签：只保留内容
  if (tag === 'br') return '<br>';
  const attrs = [];
  for (const a of node.attributes) {
    const name = a.name.toLowerCase();
    if (name === 'style') {
      const s = sanitizeStyle(a.value);
      if (s) attrs.push('style="' + escapeHtml(s) + '"');
    } else if (name === 'href' && /^(https?:|mailto:)/i.test(a.value)) {
      attrs.push('href="' + escapeHtml(a.value) + '" target="_blank" rel="noopener"');
    }
  }
  return '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + kids + '</' + tag + '>';
}

function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html == null ? '' : html);
  return Array.from(tpl.content.childNodes).map(cleanNode).join('');
}

function cssColor(v) {
  const s = String(v == null ? '' : v).trim();
  return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgb\([\d\s,.]+\))$/.test(s) ? escapeHtml(s) : 'inherit';
}

function cssSize(v) {
  if (typeof v === 'number') return Math.round(v) + 'px';
  const s = String(v == null ? '' : v).trim();
  const map = { small: '0.85em', large: '1.2em', huge: '1.6em' };
  if (map[s]) return map[s];
  return /^[\d.]+(px|em|rem|%)$/.test(s) ? escapeHtml(s) : '';
}

function applyMarkName(o, name) {
  const t = String(name || '').toLowerCase()
    .replace(/[^a-z]/g, '');
  if (['bold', 'strong'].includes(t)) o.bold = true;
  else if (['italic', 'em', 'emphasis'].includes(t)) o.italic = true;
  else if (['underline', 'u'].includes(t)) o.underline = true;
  else if (['strike', 'strikethrough', 'del', 'linethrough'].includes(t)) o.strike = true;
  else if (t === 'code') o.code = true;
  else if (t === 'small') o.small = true;
  else if (t === 'sub') o.sub = true;
  else if (t === 'sup') o.sup = true;
}

function marksToOpts(marks) {
  const o = {};
  for (const m of marks || []) {
    if (typeof m === 'string') { applyMarkName(o, m); continue; }
    if (!m || typeof m !== 'object') continue;
    const t = String(m.type || m.name || '').toLowerCase();
    applyMarkName(o, t);
    const a = m.attrs || m.attributes || {};
    if (t === 'color' || a.color) o.color = a.color != null ? a.color : m.color;
    if (['highlight', 'background', 'backgroundcolor'].includes(t.replace('-', '')) || a.background || a.backgroundColor || a.highlight) {
      o.background = a.background || a.backgroundColor || a.highlight || m.background;
    }
    if (t === 'link' || a.href) o.link = a.href || m.href || m.link;
    if (t === 'fontsize' || a.fontSize) o.size = cssSize(a.fontSize || m.size);
  }
  return o;
}

function attrsToOpts(attrs) {
  const o = {};
  if (!attrs || typeof attrs !== 'object') return o;
  for (const key of Object.keys(attrs)) {
    if (attrs[key]) applyMarkName(o, key);
  }
  if (attrs.color) o.color = attrs.color;
  if (attrs.background || attrs.bg || attrs.highlight) o.background = attrs.background || attrs.bg || attrs.highlight;
  if (attrs.link || attrs.href) o.link = attrs.link || attrs.href;
  if (attrs.size || attrs.fontSize) o.size = cssSize(attrs.size || attrs.fontSize);
  return o;
}

function wrapMarks(html, opts) {
  let out = html;
  if (!out) return out;
  const o = opts || {};
  if (o.background) out = '<span style="background-color: ' + cssColor(o.background) + '">' + out + '</span>';
  if (o.color) out = '<span style="color: ' + cssColor(o.color) + '">' + out + '</span>';
  if (o.size) out = '<span style="font-size: ' + cssSize(o.size) + '">' + out + '</span>';
  if (o.code) out = '<code>' + out + '</code>';
  if (o.small) out = '<small>' + out + '</small>';
  if (o.sub) out = '<sub>' + out + '</sub>';
  if (o.sup) out = '<sup>' + out + '</sup>';
  if (o.bold) out = '<strong>' + out + '</strong>';
  if (o.italic) out = '<em>' + out + '</em>';
  if (o.underline) out = '<u>' + out + '</u>';
  if (o.strike) out = '<s>' + out + '</s>';
  if (o.link && /^(https?:|mailto:)/i.test(o.link)) {
    out = '<a href="' + escapeHtml(o.link) + '" target="_blank" rel="noopener">' + out + '</a>';
  }
  return out;
}

function inlineToHtml(v) {
  if (v == null) return '';
  if (typeof v === 'string') {
    return /<[a-z][\s\S]*>/i.test(v) ? sanitizeHtml(v) : escapeHtml(v);
  }
  if (Array.isArray(v)) return v.map(inlineToHtml).join('');
  if (typeof v !== 'object') return escapeHtml(String(v));
  if (v.html != null) return sanitizeHtml(v.html);
  if (v.type === 'hardBreak' || v.type === 'break' || v.insert === '\n') return '<br>';

  let text = v.text;
  if (text == null) text = v.plain_text;
  if (text == null) text = v.value;
  if (text == null) text = v.content;

  let out = inlineToHtml(text);
  const opts = Object.assign(
    {},
    marksToOpts(v.marks),
    attrsToOpts(v.attributes || v.attrs || v.annotations || {})
  );
  for (const key of ['bold', 'italic', 'underline', 'strike', 'code']) {
    if (v[key]) opts[key] = true;
  }
  if (v.children) out += inlineToHtml(v.children);
  return wrapMarks(out, opts);
}

function normalizeType(raw) {
  const t = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['h1', 'heading1', 'header1', 'title'].includes(t)) return 'h1';
  if (['h2', 'heading2', 'header2', 'subtitle'].includes(t)) return 'h2';
  if (['h3', 'heading3', 'header3'].includes(t)) return 'h3';
  if (['h4', 'heading4', 'header4'].includes(t)) return 'h4';
  if (['li', 'listitem', 'bullet', 'bulletlist'].includes(t)) return 'li';
  if (['oli', 'orderedlist', 'numbered', 'numberedlist'].includes(t)) return 'oli';
  if (['quote', 'blockquote', 'citation'].includes(t)) return 'quote';
  if (['code', 'codeblock', 'pre', 'preformatted'].includes(t)) return 'code';
  return 'p';
}

function blockFrom(item) {
  if (item == null) return [];
  if (typeof item === 'string') return parsePlainOrHtml(item);
  if (Array.isArray(item)) return item.flatMap(blockFrom);
  if (typeof item !== 'object') return [];

  let rawType = item.type || item.tag || item.style || item.blockType || item.nodeType || '';
  if ((rawType === 'heading' || rawType === 'header') && item.level) rawType = 'h' + item.level;
  const type = normalizeType(rawType);

  let html;
  if (item.html != null) {
    html = sanitizeHtml(item.html);
  } else {
    let src = item.content;
    if (src == null) src = item.text;
    if (src == null) src = item.value;
    if (src == null) src = item.plain_text;
    if (src == null) src = item.rich_text;
    if (src == null) src = item.children;
    html = inlineToHtml(src);
  }

  const opts = Object.assign(
    {},
    marksToOpts(item.marks),
    attrsToOpts(Object.assign({}, item.attributes || {}, item.attrs || {}))
  );
  for (const key of ['bold', 'italic', 'underline', 'strike']) {
    if (item[key]) opts[key] = true;
  }
  html = wrapMarks(html, opts);

  const block = { type, html: html || '<br>' };
  const attrs = item.attributes || item.attrs || {};
  const align = String(item.align || item.alignment || attrs.align || '').toLowerCase();
  if (['left', 'center', 'right', 'justify'].includes(align)) block.align = align;
  return [block];
}

function deltaBlockMeta(attrs) {
  const a = attrs || {};
  let type = 'p';
  if (a.header === 1 || a.header === '1') type = 'h1';
  else if (a.header === 2 || a.header === '2') type = 'h2';
  else if (a.header) type = 'h3';
  if (a['code-block']) type = 'code';
  if (a.blockquote) type = 'quote';
  if (a.list === 'ordered') type = 'oli';
  else if (a.list) type = 'li';
  const align = String(a.align || '').toLowerCase();
  return { type, align: ['left', 'center', 'right', 'justify'].includes(align) ? align : undefined };
}

function deltaToBlocks(delta) {
  const blocks = [];
  let inline = [];
  const flush = (meta) => {
    const m = deltaBlockMeta(meta);
    const b = { type: m.type, html: inline.join('') || '<br>' };
    if (m.align) b.align = m.align;
    blocks.push(b);
    inline = [];
  };

  for (const op of delta.ops || []) {
    const ins = op.insert;
    if (typeof ins !== 'string') {
      if (ins && typeof ins === 'object') {
        if (ins.image) inline.push('［图片］');
        else if (ins.mention) inline.push(escapeHtml('@' + (ins.mention.value || '')));
      }
      continue;
    }
    const parts = ins.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) flush(i === parts.length - 1 && ins.endsWith('\n') ? (op.attributes || {}) : {});
      if (parts[i]) inline.push(wrapMarks(escapeHtml(parts[i]), attrsToOpts(op.attributes)));
    }
  }
  if (inline.length) flush({});
  return blocks;
}

function lineToBlock(line) {
  let m;
  if ((m = line.match(/^(#{1,4})\s+(.*)$/))) return { type: 'h' + m[1].length, html: escapeHtml(m[2]) };
  if ((m = line.match(/^>\s?(.*)$/))) return { type: 'quote', html: escapeHtml(m[1]) };
  if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) return { type: 'li', html: escapeHtml(m[1]) };
  if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) return { type: 'oli', html: escapeHtml(m[1]) };
  return { type: 'p', html: line ? escapeHtml(line) : '<br>' };
}

function htmlToBlocks(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  const topNodes = Array.from(tpl.content.childNodes);
  const hasBlockTag = topNodes.some((n) => n.nodeType === 1 &&
    ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'section', 'article', 'table'].includes(n.tagName.toLowerCase()));

  // 只有行内标签时，整体作为一个段落，保留加粗/颜色等样式
  if (!hasBlockTag && topNodes.some((n) => n.nodeType !== 3 || n.textContent.trim())) {
    return [{ type: 'p', html: sanitizeHtml(html) }];
  }

  const out = [];
  for (const node of topNodes) {
    if (node.nodeType === 3) {
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (text) out.push({ type: 'p', html: escapeHtml(text) });
      continue;
    }
    if (node.nodeType !== 1) continue;
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'br'].includes(tag)) continue;
    if (tag === 'ul' || tag === 'ol') {
      for (const li of node.querySelectorAll(':scope > li')) {
        out.push({ type: tag === 'ol' ? 'oli' : 'li', html: sanitizeHtml(li.innerHTML) });
      }
      continue;
    }
    out.push({ type: normalizeType(tag), html: sanitizeHtml(node.innerHTML) || '<br>' });
  }
  return out.length ? out : [{ type: 'p', html: '<br>' }];
}

function parsePlainOrHtml(text) {
  const t = String(text).replace(/\r/g, '');
  if (/<[a-z][\s\S]*>/i.test(t)) return htmlToBlocks(t);
  return t.split('\n').map(lineToBlock);
}

function fromStructure(data) {
  if (data == null) return [];
  if (typeof data === 'string') return parsePlainOrHtml(data);
  if (Array.isArray(data)) return data.flatMap(fromStructure);
  if (typeof data !== 'object') return [];
  if (Array.isArray(data.ops)) return deltaToBlocks(data);

  const t = String(data.type || data.nodeType || '').toLowerCase();
  if (data.type === 'doc' || data.type === 'root') return fromStructure(data.content || data.children || []);

  // ProseMirror / Notion 风格的块对象：内容数组属于该块的内联节点
  if (['paragraph', 'heading', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'listitem', 'li', 'code', 'text'].includes(t)) {
    if (t === 'text') return [{ type: 'p', html: inlineToHtml(data) }];
    return blockFrom(data);
  }

  // 带 type 且已有 html/text 的块，直接按块解析，保留引用/列表/标题等类型
  if (data.type && (data.html != null || data.text != null || data.content != null || data.rich_text != null)) {
    return blockFrom(data);
  }

  for (const key of ['blocks', 'content', 'paragraphs', 'items', 'data', 'children']) {
    if (Array.isArray(data[key])) return fromStructure(data[key]);
  }
  for (const key of ['html', 'text', 'plain_text', 'value', 'content']) {
    if (typeof data[key] === 'string') return parsePlainOrHtml(data[key]);
  }
  if (data.text != null || data.html != null || data.type) return blockFrom(data);

  const nested = Object.values(data).find((v) => v && typeof v === 'object');
  return nested ? fromStructure(nested) : [];
}

function parseInput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  try {
    return fromStructure(JSON.parse(trimmed));
  } catch (_) {
    return parsePlainOrHtml(trimmed);
  }
}

/* ============================================================
 * 渲染 / 存储
 * ============================================================ */

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'div']);
const BLOCK_TAG_BY_TYPE = {
  p: 'p', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', quote: 'blockquote', code: 'pre', div: 'div',
};

function renderScript() {
  const frag = document.createDocumentFragment();
  let list = null;

  for (const b of state.blocks) {
    if (b.type === 'li' || b.type === 'oli') {
      const tag = b.type === 'oli' ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = document.createElement(tag);
        frag.appendChild(list);
      }
      const li = document.createElement('li');
      li.innerHTML = sanitizeHtml(b.html);
      list.appendChild(li);
      continue;
    }
    list = null;
    const el = document.createElement(BLOCK_TAGS.has(BLOCK_TAG_BY_TYPE[b.type]) ? BLOCK_TAG_BY_TYPE[b.type] : 'p');
    el.innerHTML = sanitizeHtml(b.html);
    if (b.align) el.style.textAlign = b.align;
    frag.appendChild(el);
  }

  script.replaceChildren(frag);
  script.classList.toggle('mirrored', state.mirror);
  script.style.setProperty('--script-size', state.fontSize + 'px');
  state.charCount = script.textContent.replace(/\s/g, '').length;
  measure();
}

function saveScript() {
  try {
    localStorage.setItem(LS.script, JSON.stringify({
      format: 'teleprompter-script', version: 1, blocks: state.blocks,
    }));
  } catch (e) {
    toast('本地存储不可用，请导出 JSON 备份');
  }
}

function loadScript() {
  try {
    const raw = localStorage.getItem(LS.script);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const blocks = Array.isArray(data) ? data : data.blocks;
    return Array.isArray(blocks) && blocks.length ? blocks : null;
  } catch (e) {
    return null;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(LS.settings, JSON.stringify({
      speed: state.speed, fontSize: state.fontSize, mirror: state.mirror, theme: state.theme,
    }));
  } catch (e) { /* 忽略 */ }
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS.settings) || '{}');
    if (typeof s.speed === 'number') state.speed = Math.min(300, Math.max(10, s.speed));
    if (typeof s.fontSize === 'number') state.fontSize = Math.min(72, Math.max(18, s.fontSize));
    state.mirror = !!s.mirror;
    if (s.theme === 'light' || s.theme === 'dark') state.theme = s.theme;
  } catch (e) { /* 忽略 */ }
}

/* ============================================================
 * 滚动引擎
 * ============================================================ */

function measure() {
  script.style.paddingTop = Math.max(0, Math.round(viewport.clientHeight * 0.38 - state.fontSize * 0.9)) + 'px';
  script.style.paddingBottom = Math.round(viewport.clientHeight * 0.7) + 'px';
  state.maxOffset = Math.max(0, script.offsetHeight - viewport.clientHeight);
  setOffset(state.offset);
}

function setOffset(px) {
  state.offset = Math.min(state.maxOffset, Math.max(0, px));
  track.style.transform = 'translate3d(0, ' + (-state.offset).toFixed(2) + 'px, 0)';
  const pct = state.maxOffset > 0 ? Math.min(100, Math.round((state.offset / state.maxOffset) * 100)) : 0;
  progressFill.style.width = pct + '%';
  posText.textContent = pct + '% · ' + state.charCount + ' 字';
}

function setPlaying(on, note) {
  state.playing = !!on;
  btnPlay.textContent = state.playing ? '❚❚ 暂停' : '▶ 播放';
  statusText.textContent = note || (state.playing ? '播放中' : '已暂停');
}

function togglePlay() {
  if (state.editing) return;
  if (!state.playing && state.offset >= state.maxOffset && state.maxOffset > 0) setOffset(0);
  setPlaying(!state.playing);
}

function nudge(delta) {
  if (state.playing) setPlaying(false);
  setOffset(state.offset + delta);
}

function changeSpeed(delta) {
  state.speed = Math.min(300, Math.max(10, state.speed + delta));
  speedRange.value = state.speed;
  speedValue.textContent = state.speed + ' px/s';
  saveSettings();
}

function changeFont(delta) {
  state.fontSize = Math.min(72, Math.max(18, state.fontSize + delta));
  script.style.setProperty('--script-size', state.fontSize + 'px');
  fontValue.textContent = state.fontSize + 'px';
  measure();
  saveSettings();
}

function loop(ts) {
  const dt = Math.min(0.05, (ts - state.lastTs) / 1000 || 0);
  state.lastTs = ts;
  if (state.playing && !state.dragging && !state.editing) {
    let next = state.offset + state.speed * dt;
    if (next >= state.maxOffset) {
      next = state.maxOffset;
      setPlaying(false, '已到末尾');
    }
    setOffset(next);
  }
  requestAnimationFrame(loop);
}

/* ============================================================
 * 交互
 * ============================================================ */

let dragStartY = 0;
let dragStartOffset = 0;

viewport.addEventListener('pointerdown', (e) => {
  if (state.editing || e.button !== 0 || e.target.closest('button')) return;
  state.dragging = true;
  dragStartY = e.clientY;
  dragStartOffset = state.offset;
  viewport.classList.add('dragging');
  viewport.setPointerCapture(e.pointerId);
  setPlaying(false, '已暂停 · 手动滑动');
});

viewport.addEventListener('pointermove', (e) => {
  if (!state.dragging) return;
  setOffset(dragStartOffset - (e.clientY - dragStartY));
});

function endDrag(e) {
  if (!state.dragging) return;
  state.dragging = false;
  viewport.classList.remove('dragging');
  if (e && e.pointerId != null && viewport.hasPointerCapture(e.pointerId)) {
    viewport.releasePointerCapture(e.pointerId);
  }
}
viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);

viewport.addEventListener('wheel', (e) => {
  if (state.editing) return;
  e.preventDefault();
  if (state.playing) setPlaying(false, '已暂停 · 手动滑动');
  setOffset(state.offset + e.deltaY);
}, { passive: false });

document.addEventListener('keydown', (e) => {
  const target = e.target;
  if (target && target.closest && target.closest('input, textarea, [contenteditable="true"]')) return;
  if (!pasteModal.hidden) {
    if (e.key === 'Escape') closePaste();
    return;
  }
  switch (e.key) {
    case ' ':
      e.preventDefault(); togglePlay(); break;
    case 'ArrowDown':
      e.preventDefault(); nudge(40); break;
    case 'ArrowUp':
      e.preventDefault(); nudge(-40); break;
    case '+': case '=':
      e.preventDefault(); changeSpeed(10); break;
    case '-': case '_':
      e.preventDefault(); changeSpeed(-10); break;
    case 'Home':
      e.preventDefault(); setOffset(0); break;
    case 'End':
      e.preventDefault(); setOffset(state.maxOffset); break;
    case 'Escape':
      if (state.editing) setEditing(false); break;
    default: break;
  }
});

btnPlay.addEventListener('click', togglePlay);
$('btnReset').addEventListener('click', () => { setPlaying(false, '已回到开头'); setOffset(0); });
$('btnSlower').addEventListener('click', () => changeSpeed(-10));
$('btnFaster').addEventListener('click', () => changeSpeed(10));
$('btnFontSmall').addEventListener('click', () => changeFont(-2));
$('btnFontLarge').addEventListener('click', () => changeFont(2));
speedRange.addEventListener('input', () => {
  state.speed = Number(speedRange.value);
  speedValue.textContent = state.speed + ' px/s';
  saveSettings();
});

$('btnTheme').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.body.dataset.theme = state.theme;
  saveSettings();
});

$('btnMirror').addEventListener('click', (e) => {
  state.mirror = !state.mirror;
  script.classList.toggle('mirrored', state.mirror);
  e.currentTarget.classList.toggle('active', state.mirror);
  saveSettings();
});

btnEdit.addEventListener('click', () => setEditing(!state.editing));

function setEditing(on) {
  state.editing = !!on;
  stage.classList.toggle('editing', state.editing);
  script.contentEditable = state.editing ? 'true' : 'false';
  btnEdit.textContent = state.editing ? '✓ 完成编辑' : '编辑';
  if (state.editing) {
    setPlaying(false, '编辑模式');
    viewport.scrollTop = 0;
  } else {
    const blocks = htmlToBlocks(script.innerHTML);
    state.blocks = blocks.length ? blocks : [{ type: 'p', html: '<br>' }];
    saveScript();
    renderScript();
    setOffset(0);
    toast('文稿已保存到本地');
  }
}

/* ---------- 导入 / 导出 ---------- */

function loadBlocks(blocks, label) {
  if (!blocks || !blocks.length) { toast('没有解析出可显示的内容'); return; }
  state.blocks = blocks;
  saveScript();
  renderScript();
  setPlaying(false, '就绪');
  setOffset(0);
  toast((label || '已载入') + ' · ' + blocks.length + ' 段');
}

$('btnImport').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    loadBlocks(parseInput(text), '已导入 ' + file.name);
  } catch (err) {
    toast('读取文件失败：' + err.message);
  }
  fileInput.value = '';
});

function closePaste() { pasteModal.hidden = true; }
$('btnPaste').addEventListener('click', () => {
  pasteArea.value = '';
  pasteModal.hidden = false;
  pasteArea.focus();
});
$('btnCloseModal').addEventListener('click', closePaste);
$('btnCancelPaste').addEventListener('click', closePaste);
pasteModal.addEventListener('click', (e) => { if (e.target === pasteModal) closePaste(); });
$('btnApplyPaste').addEventListener('click', () => {
  loadBlocks(parseInput(pasteArea.value), '已载入粘贴内容');
  closePaste();
});

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('btnExportJson').addEventListener('click', () => {
  download('提词文稿.json', JSON.stringify({
    format: 'teleprompter-script', version: 1, blocks: state.blocks,
  }, null, 2), 'application/json');
  toast('已导出 JSON 文稿');
});

$('btnExportTxt').addEventListener('click', () => {
  const div = document.createElement('div');
  let n = 0;
  const lines = state.blocks.map((b) => {
    div.innerHTML = sanitizeHtml(b.html);
    const text = div.textContent.replace(/\u00a0/g, ' ').trim();
    if (b.type === 'li') return '- ' + text;
    if (b.type === 'oli') { n += 1; return n + '. ' + text; }
    n = 0;
    return text;
  });
  download('提词文稿.txt', lines.join('\n'), 'text/plain');
  toast('已导出 TXT 文稿');
});

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

/* ============================================================
 * 启动
 * ============================================================ */

function init() {
  loadSettings();
  document.body.dataset.theme = state.theme;
  speedRange.value = state.speed;
  speedValue.textContent = state.speed + ' px/s';
  fontValue.textContent = state.fontSize + 'px';
  $('btnMirror').classList.toggle('active', state.mirror);

  const saved = loadScript();
  state.blocks = saved ? saved : sampleBlocks.map((b) => Object.assign({}, b));
  renderScript();

  // 尺寸变化时重新计算朗读线位置与最大滚动距离
  const ro = new ResizeObserver(() => { if (!state.editing) measure(); });
  ro.observe(viewport);
  window.addEventListener('resize', () => { if (!state.editing) measure(); });

  state.lastTs = performance.now();
  requestAnimationFrame(loop);
}

init();
