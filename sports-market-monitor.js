'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) root.__sportsMarketMonitor = api;
})(typeof window !== 'undefined' ? window : null, function () {
  function timeText(value) {
    const stamp = Date.parse(value || '');
    if (!Number.isFinite(stamp)) return '時間不明';
    return new Date(stamp + 8 * 3600000).toISOString().slice(11, 16);
  }

  function addText(parent, className, value) {
    const element = parent.ownerDocument.createElement('span');
    element.className = className;
    element.textContent = value == null ? '' : String(value);
    parent.appendChild(element);
    return element;
  }

  function stateText(source) {
    if (source.statusText) return source.statusText;
    if (source.available === false || !source.current || source.current === '未取得方向') return '待資料';
    return source.changed ? '曾對調' : '未對調';
  }

  function addSummary(head, source) {
    const cell = head.ownerDocument.createElement('span');
    cell.className = `market-platform ${source.key || ''}${source.changed ? ' changed' : ''}`.trim();
    addText(cell, 'market-source', source.label || source.key || '盤口');
    addText(cell, 'market-current', source.current || '未取得方向');
    addText(cell, 'market-state', stateText(source));
    head.appendChild(cell);
  }

  function addDetailLine(section, label, value) {
    const line = section.ownerDocument.createElement('div');
    line.className = 'market-detail-line';
    addText(line, 'market-detail-key', label);
    addText(line, 'market-detail-value', value);
    section.appendChild(line);
  }

  function addEvents(section, events) {
    if (!events.length) {
      addDetailLine(section, '變動', '沒有讓分方或基準線變動');
      return;
    }
    const list = section.ownerDocument.createElement('div');
    list.className = 'market-timeline';
    for (const event of events) {
      if (!event || !event.text) continue;
      const row = section.ownerDocument.createElement('div');
      const noTime = Object.prototype.hasOwnProperty.call(event, 'displayTime') && event.displayTime === '';
      row.className = `market-event${noTime ? ' no-time' : ''}`;
      if (!noTime) addText(row, 'market-event-time', event.displayTime || timeText(event.at));
      addText(row, 'market-event-text', event.text);
      list.appendChild(row);
    }
    if (list.childNodes.length) section.appendChild(list);
    else addDetailLine(section, '變動', '沒有讓分方或基準線變動');
  }

  function addControls(section, controls) {
    if (!controls.length) return;
    const wrap = section.ownerDocument.createElement('div');
    wrap.className = 'market-auto-controls';
    for (const control of controls) {
      if (!control || typeof control.onClick !== 'function') continue;
      const button = section.ownerDocument.createElement('button');
      button.type = 'button';
      button.textContent = control.label || '執行';
      button.onclick = function (event) {
        event.stopPropagation();
        control.onClick();
      };
      wrap.appendChild(button);
    }
    if (wrap.childNodes.length) section.appendChild(wrap);
  }

  function normalizeDetails(details) {
    return (Array.isArray(details) ? details : []).map((entry) => {
      if (Array.isArray(entry)) return { label: entry[0], text: entry[1] };
      return entry || {};
    }).filter((entry) => entry.label && entry.text != null);
  }

  function renderPlatformMonitor(options) {
    const documentRef = options && options.documentRef;
    const sources = options && Array.isArray(options.sources) ? options.sources.filter(Boolean) : [];
    if (!documentRef || !sources.length) return null;

    const root = documentRef.createElement('div');
    const sides = sources.map((source) => source.side).filter((side) => side === 'away' || side === 'home');
    const diverged = sides.length > 1 && sides.some((side) => side !== sides[0]);
    root.className = `market-monitor source-count-${sources.length}${diverged ? ' diverged' : ' aligned'}`;

    const head = documentRef.createElement('button');
    head.type = 'button';
    head.className = 'market-monitor-head';
    head.setAttribute('aria-expanded', 'false');
    head.title = '展開盤口變動明細';
    for (const source of sources) addSummary(head, source);
    addText(head, 'market-monitor-caret', '⌄');
    root.appendChild(head);

    const details = documentRef.createElement('div');
    details.className = 'market-monitor-details';
    details.hidden = true;
    for (const source of sources) {
      const section = documentRef.createElement('section');
      section.className = `market-detail-section ${source.key || ''}`.trim();
      const heading = documentRef.createElement('h4');
      heading.textContent = source.label || source.key || '盤口';
      section.appendChild(heading);
      const rows = normalizeDetails(source.details);
      if (rows.length) for (const row of rows) addDetailLine(section, row.label, row.text);
      else addDetailLine(section, '狀態', source.missingText || (source.available === false ? '尚未取得盤口' : '目前沒有市場明細'));
      addEvents(section, Array.isArray(source.events) ? source.events : []);
      if (source.sourceLabel) addDetailLine(section, '來源', source.sourceLabel);
      addControls(section, Array.isArray(source.controls) ? source.controls : []);
      details.appendChild(section);
    }

    head.onclick = function () {
      const open = details.hidden;
      details.hidden = !open;
      head.classList.toggle('open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    root.appendChild(details);
    return root;
  }

  return { renderPlatformMonitor, timeText };
});
