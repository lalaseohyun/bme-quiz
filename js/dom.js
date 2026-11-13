// dom.js — 화면 공용 헬퍼

/** h('button', { class: 'x', onclick: fn }, '글자') */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter(c => c != null && c !== false));
  return el;
}

/** 같은 틱에 몰린 호출을 한 번으로 모은다. rAF는 백그라운드 탭에서 멈추므로 쓰지 않는다. */
export function batcher(fn) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; fn(); }, 0);
  };
}

/** '가 **나** 다' → ['가 ', <strong>나</strong>, ' 다']. innerHTML을 쓰지 않는다. */
export const rich = text => String(text).split(/\*\*(.+?)\*\*/g)
  .map((part, i) => (i % 2 ? h('strong', null, part) : part));

/** 해설 본문: 빈 줄을 뺀 줄마다 <p>, 줄 안의 **굵게**는 <strong> */
export const paragraphs = text => String(text).split('\n').filter(l => l.trim()).map(l => h('p', null, rich(l)));

export const MARKS = ['①', '②', '③', '④', '⑤', '⑥'];
