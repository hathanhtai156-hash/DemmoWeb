/* DRIVER FINAL WORKFLOW - Nhận đơn -> Đang trên đường đến -> Hoàn tất, hoàn tất thì chuyển qua lịch sử */
(function () {
  const API = window.API_BASE || '/api';
  const ACTIVE_KEY = 'logiport_driver_active_status_v4';
  const HIDDEN_KEY = 'logiport_driver_completed_hidden_v4';
  const HISTORY_KEY = 'logiport_driver_delivered_history_v4';
  const TRACKING_STATUS_KEY = 'logiport_tracking_status_overrides_v1';
  const TRACKING_DONE_KEY = 'logiport_tracking_completed_orders_v1';
  const LEGACY_STATUS_KEY = 'logiport_driver_status_overrides';
  const DRIVER_NAMES = ['Tài xế Demo', 'taixe'];

  const esc = (value = '') => String(value ?? '').replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
  const norm = (value = '') => String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().trim();
  const parseJson = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch { return fallback; }
  };
  const getToken = () => window.authToken || localStorage.getItem('logiport_token') || '';
  const getUser = () => window.currentUser || parseJson('logiport_user', {}) || {};
  const getOrderId = o => String(o?.orderId || o?.id || o?.code || o?.maDon || '').trim();
  const getMap = () => parseJson(ACTIVE_KEY, {});
  const setMap = map => localStorage.setItem(ACTIVE_KEY, JSON.stringify(map || {}));
  const getHidden = () => parseJson(HIDDEN_KEY, []).map(String);
  const setHidden = arr => localStorage.setItem(HIDDEN_KEY, JSON.stringify([...new Set((arr || []).map(String))]));
  const getHistory = () => parseJson(HISTORY_KEY, []);
  const setHistory = arr => localStorage.setItem(HISTORY_KEY, JSON.stringify((arr || []).slice(0, 80)));

  function isDriver() {
    const u = getUser();
    return !!getToken() && (u.role === 'driver' || u.username === 'taixe' || norm(u.displayName).includes('tai xe'));
  }

  function driverAllowed(order) {
    const u = getUser();
    const rawDriver = order?.driver || order?.driverName || order?.assignedDriver || 'Tài xế Demo';
    const driver = norm(rawDriver);
    const names = [u.displayName, u.username, ...DRIVER_NAMES].map(norm).filter(Boolean);
    if (!driver || driver === norm('Chưa phân')) return true;
    if (names.some(name => driver.includes(name) || name.includes(driver))) return true;
    // Demo cũ có thể sinh Tài xế 101/102; acc taixe được phép xử lý để không bị mất đơn.
    if ((u.username === 'taixe' || norm(u.displayName).includes('tai xe')) && driver.includes('tai xe')) return true;
    return false;
  }

  function statusMeta(status = '') {
    const s = norm(status);
    if (s.includes('hoan tat') || s.includes('da giao hang') || s === 'completed') {
      return { label: 'Hoàn tất', cls: 'done', pct: 100, next: null, btn: '', done: true };
    }
    if (s.includes('dang tren duong') || s.includes('dang giao') || s.includes('dang van chuyen') || s.includes('tai xe da nhan') || s === 'driver_received' || s === 'delivering') {
      return { label: 'Đang trên đường đến', cls: 'ship', pct: 72, next: 'Hoàn tất', btn: '✅ Hoàn tất đơn', done: false };
    }
    return { label: 'Chờ nhận', cls: 'pending', pct: 24, next: 'Đang trên đường đến', btn: '📦 Nhận đơn', done: false };
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  async function fetchActiveOrders() {
    try {
      const res = await fetch(`${API}/orders`, { headers: { Authorization: `Bearer ${getToken()}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'Không tải được đơn tài xế.');
      return data.orders || [];
    } catch (error) {
      console.warn('Driver active fetch fallback:', error);
      return Array.isArray(window.__driverRawOrdersCache) ? window.__driverRawOrdersCache : [];
    }
  }

  async function fetchCompletedOrders() {
    try {
      const res = await fetch(`${API}/driver/completed-orders`, { headers: { Authorization: `Bearer ${getToken()}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return [];
      return data.orders || [];
    } catch {
      return [];
    }
  }

  function mergeActiveState(rows) {
    const map = getMap();
    const hidden = new Set(getHidden());
    return (rows || [])
      .map(o => {
        const id = getOrderId(o);
        return map[id] ? { ...o, status: map[id] } : o;
      })
      .filter(o => {
        const id = getOrderId(o);
        if (!id || hidden.has(id)) return false;
        if (!driverAllowed(o)) return false;
        return !statusMeta(o.status).done;
      })
      .sort((a, b) => {
        const aMeta = statusMeta(a.status), bMeta = statusMeta(b.status);
        if (aMeta.pct !== bMeta.pct) return aMeta.pct - bMeta.pct;
        return Number(a.deliverySequence || 999) - Number(b.deliverySequence || 999);
      });
  }

  function simplifyOrder(order = {}) {
    const id = getOrderId(order);
    return {
      orderId: id,
      code: id,
      customer: order.customer || 'Khách hàng',
      phone: order.phone || '',
      address: order.address || '',
      deliveryPoint: order.deliveryPoint || order.address || 'Điểm giao',
      deliveryZone: order.deliveryZone || 'Tuyến giao',
      shipmentNo: order.shipmentNo || 'SHIP-GV-001',
      totalWeightKg: Number(order.totalWeightKg || order.weightKg || 0),
      total: Number(order.total || 0),
      status: 'Hoàn tất',
      updatedAt: order.updatedAt || new Date().toISOString(),
      completedAt: order.completedAt || new Date().toISOString()
    };
  }

  function pushHistory(order) {
    const item = simplifyOrder(order);
    const list = getHistory().filter(x => getOrderId(x) !== item.orderId);
    list.unshift(item);
    setHistory(list);
  }

  function sameId(a = '', b = '') {
    return norm(a) === norm(b);
  }

  function persistTrackingState(order = {}, status = '') {
    const id = getOrderId(order);
    if (!id) return;
    const now = new Date().toISOString();
    const done = statusMeta(status).done;
    const currentLocation = done ? 'Đã giao đến khách hàng' : 'Tài xế đang trên đường đến điểm giao';
    const note = done
      ? 'Tài xế đã giao xong, đơn được lưu vào lịch sử đã giao.'
      : 'Tài xế đã nhận đơn và đang trên đường đến điểm giao.';

    const state = {
      ...order,
      orderId: id,
      code: order.code || id,
      status,
      currentLocation,
      note,
      updatedAt: now,
      completedAt: done ? now : (order.completedAt || ''),
      eta: done ? 'Đã giao' : 'Đang giao',
      driver: order.driver || 'Tài xế Demo'
    };

    const trackingMap = parseJson(TRACKING_STATUS_KEY, {});
    trackingMap[id] = state;
    localStorage.setItem(TRACKING_STATUS_KEY, JSON.stringify(trackingMap));

    const legacyMap = parseJson(LEGACY_STATUS_KEY, {});
    legacyMap[id] = status;
    localStorage.setItem(LEGACY_STATUS_KEY, JSON.stringify(legacyMap));

    const savedOrders = parseJson('logiport_orders', []);
    const index = savedOrders.findIndex(item => sameId(getOrderId(item), id));
    if (index >= 0) savedOrders[index] = { ...savedOrders[index], ...state };
    else savedOrders.push(state);
    localStorage.setItem('logiport_orders', JSON.stringify(savedOrders));

    if (done) {
      const doneList = parseJson(TRACKING_DONE_KEY, []).filter(item => !sameId(getOrderId(item), id));
      doneList.unshift(state);
      localStorage.setItem(TRACKING_DONE_KEY, JSON.stringify(doneList.slice(0, 80)));
    }
  }

  function formatTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  }

  function renderHistoryRows(rows = []) {
    const box = document.getElementById('driverDeliveredList');
    if (!box) return;
    const local = getHistory();
    const merged = [...local, ...(rows || [])]
      .map(simplifyOrder)
      .filter((o, index, arr) => arr.findIndex(x => getOrderId(x) === getOrderId(o)) === index)
      .sort((a, b) => new Date(b.completedAt || b.updatedAt || 0) - new Date(a.completedAt || a.updatedAt || 0))
      .slice(0, 12);
    if (!merged.length) {
      box.innerHTML = '<div class="driver-history-empty"><strong>Chưa có đơn đã giao.</strong><span>Khi bấm Hoàn tất, đơn sẽ tự chuyển qua đây.</span></div>';
      return;
    }
    box.innerHTML = merged.map(o => `<article class="driver-delivered-item">
      <div><strong>${esc(getOrderId(o))}</strong><span>${esc(o.customer || 'Khách hàng')}</span></div>
      <p>${esc(o.deliveryPoint || o.address || 'Điểm giao')}</p>
      <small>✅ Đã giao · ${esc(formatTime(o.completedAt || o.updatedAt))}</small>
    </article>`).join('');
  }

  async function renderDeliveredHistory() {
    if (!isDriver()) {
      renderHistoryRows([]);
      return;
    }
    renderHistoryRows(await fetchCompletedOrders());
  }

  function updateKpis(rows) {
    const pending = rows.filter(o => statusMeta(o.status).label === 'Chờ nhận').length;
    const shipping = rows.filter(o => statusMeta(o.status).label === 'Đang trên đường đến').length;
    const km = rows.reduce((sum, o) => sum + Number(o.estimatedKm || 0), 0) || Number(rows[0]?.estimatedKm || 0) || 0;
    setText('driverTotalOrders', rows.length);
    setText('driverPendingOrders', pending);
    setText('driverShippingOrders', shipping);
    setText('driverEstimatedKm', `${km.toFixed(1)} km`);
  }

  function shortPoint(value = '') {
    return String(value || '')
      .replace(/,\s*(TP\.?HCM|TP Hồ Chí Minh|Thành phố Hồ Chí Minh)/gi, '')
      .replace(/Phường\s*/gi, 'P.')
      .trim();
  }

  function pointMeta(label = '') {
    if (typeof window.routePointMeta === 'function') return window.routePointMeta(label);
    const text = norm(label);
    const checksum = [...text].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    return { label, x: (checksum % 19) / 3, y: (checksum % 29) / 4 };
  }

  function distanceBetween(from = '', to = '') {
    try {
      if (typeof window.routeDistanceKm === 'function') {
        return Number(window.routeDistanceKm(pointMeta(from), pointMeta(to)) || 0);
      }
    } catch (_) {}
    const a = pointMeta(from);
    const b = pointMeta(to);
    const dx = Number(a.x || 0) - Number(b.x || 0);
    const dy = Number(a.y || 0) - Number(b.y || 0);
    return Number(Math.max(0.4, Math.sqrt(dx * dx + dy * dy) * 2.65).toFixed(1));
  }

  function buildGreedyProcess(rows = []) {
    const depot = 'Kho LogiPort - 69 Nguyễn Gia Trí, Bình Thạnh';
    const groups = [];
    (rows || []).forEach(order => {
      const label = order.deliveryPoint || order.address || order.route || 'Điểm giao';
      const key = norm(label);
      let group = groups.find(item => item.key === key);
      if (!group) {
        group = { key, label, orders: [], totalWeightKg: 0 };
        groups.push(group);
      }
      group.orders.push(order);
      group.totalWeightKg += Number(order.totalWeightKg || order.weightKg || 0);
    });

    const remaining = groups.map(group => ({ ...group }));
    const steps = [];
    let current = { label: depot };
    let totalKm = 0;

    while (remaining.length) {
      const candidates = remaining.map((stop, index) => ({
        index,
        label: stop.label,
        km: distanceBetween(current.label, stop.label),
        ordersCount: stop.orders.length,
        totalWeightKg: Number(stop.totalWeightKg.toFixed(1))
      })).sort((a, b) => a.km - b.km || a.label.localeCompare(b.label, 'vi'));
      const best = candidates[0];
      const selected = remaining.splice(best.index, 1)[0];
      totalKm += Number(best.km || 0);
      steps.push({
        step: steps.length + 1,
        from: current.label,
        selected: selected.label,
        selectedKm: Number(best.km || 0),
        candidates: candidates.slice(0, 5),
        ordersCount: selected.orders.length,
        totalWeightKg: Number(selected.totalWeightKg.toFixed(1)),
        reason: `${shortPoint(selected.label)} gần nhất tại thời điểm này: ${Number(best.km || 0).toFixed(1)}km.`
      });
      current = { label: selected.label };
    }

    return {
      depot,
      steps,
      route: [depot, ...steps.map(step => step.selected)],
      totalKm: Number(totalKm.toFixed(1)),
      stopCount: groups.length
    };
  }

  function renderRoute(rows) {
    const box = document.getElementById('driverGreedyIntegrated');
    if (!box) return;
    if (!rows.length) {
      window.__driverGreedySequenceMap = {};
      box.innerHTML = '<div class="empty-greedy-driver">Không còn tuyến đang giao. Đơn đã hoàn tất nằm ở mục “Đơn đã giao”.</div>';
      return;
    }

    const plan = buildGreedyProcess(rows);
    window.__driverGreedySequenceMap = {};
    plan.steps.forEach(step => { window.__driverGreedySequenceMap[norm(step.selected)] = step; });
    setText('driverEstimatedKm', `${plan.totalKm.toFixed(1)} km`);

    const first = plan.steps[0];
    const firstDecision = first ? `<div class="greedy-first-decision">
      <div><span>Bước 1 đang ở</span><strong>${esc(shortPoint(first.from))}</strong></div>
      <i class="fa-solid fa-arrow-right"></i>
      <div><span>So sánh các đơn còn lại</span><p>${first.candidates.map((c, i) => `<b class="${i === 0 ? 'winner' : ''}">${esc(shortPoint(c.label))}: ${Number(c.km).toFixed(1)}km</b>`).join('')}</p></div>
      <i class="fa-solid fa-arrow-right"></i>
      <div><span>Kết quả</span><strong>Chọn ${esc(shortPoint(first.selected))}</strong><small>vì gần nhất hiện tại</small></div>
    </div>` : '';

    const processHtml = `
      <div class="greedy-rule-strip">
        <div><b>Greedy = thuật toán tham lam</b><span>Không xét lại toàn bộ, mỗi bước lấy phương án tốt nhất ngay tại vị trí hiện tại.</span></div>
        <div><b>Công thức demo</b><span>Từ vị trí đang đứng → tính km tới mọi điểm chưa giao → chọn km nhỏ nhất.</span></div>
      </div>
      <div class="greedy-process-flow">
        <span>1. Kho xuất phát</span><i>→</i><span>2. Candidate Set</span><i>→</i><span>3. Chọn đơn gần nhất</span><i>→</i><span>4. Cập nhật vị trí</span><i>→</i><span>5. Lặp đến khi xong</span>
      </div>`;

    const stepHtml = plan.steps.map(step => `<article class="driver-final-step greedy-clear-step">
      <b>${step.step}</b>
      <div><small>Đang ở</small><strong>${esc(shortPoint(step.from))}</strong></div>
      <i>→</i>
      <div><small>Chọn gần nhất</small><strong>${esc(shortPoint(step.selected))}</strong><small>${esc(step.ordersCount)} đơn · ${Number(step.totalWeightKg || 0).toFixed(1)}kg</small></div>
      <em>${Number(step.selectedKm || 0).toFixed(1)}km</em>
    </article>`).join('');

    const tableRows = plan.steps.map(step => `<tr>
      <td><b>${step.step}</b></td>
      <td>${esc(shortPoint(step.from))}</td>
      <td><strong>${esc(shortPoint(step.selected))}</strong></td>
      <td>${step.candidates.map((candidate, index) => `<span class="candidate-chip ${index === 0 ? 'picked' : ''}">${esc(shortPoint(candidate.label))} · ${Number(candidate.km || 0).toFixed(1)}km</span>`).join('')}</td>
      <td>${esc(step.reason)}</td>
    </tr>`).join('');

    box.innerHTML = `<section class="driver-final-route greedy-driver-clear-board">
      <div class="driver-final-route-head greedy-driver-head">
        <div><span>Tuyến giao hôm nay</span><h2>Greedy: Kho → đơn gần nhất → đơn gần nhất tiếp theo → hoàn tất</h2><p>Hiển thị đúng quy trình trong hình: tài xế đứng ở đâu thì hệ thống chọn điểm gần nhất từ vị trí đó.</p></div>
        <strong>${plan.stopCount} điểm · ${plan.totalKm.toFixed(1)}km</strong>
      </div>
      ${processHtml}
      ${firstDecision}
      <div class="driver-final-pills greedy-route-pills">${plan.route.map((p, i) => `<span class="${i === 0 ? 'depot' : ''}">${i === 0 ? 'Kho' : '#' + i} · ${esc(shortPoint(p))}</span>`).join('<i>→</i>')}</div>
      <div class="driver-final-steps greedy-clear-steps">${stepHtml}</div>
      <details class="greedy-step-details greedy-driver-table" open>
        <summary><i class="fa-solid fa-diagram-project"></i> Bảng giải thích từng bước Greedy</summary>
        <div class="greedy-step-scroll"><table class="greedy-step-table"><thead><tr><th>Bước</th><th>Vị trí hiện tại</th><th>Điểm được chọn</th><th>Các ứng viên còn lại</th><th>Lý do chọn</th></tr></thead><tbody>${tableRows}</tbody></table></div>
      </details>
    </section>`;
  }

  function cardHtml(order) {
    const id = getOrderId(order);
    const point = order.deliveryPoint || order.address || 'Điểm giao';
    const m = statusMeta(order.status);
    const kg = Number(order.totalWeightKg || order.weightKg || 0).toFixed(1);
    const greedyStep = (window.__driverGreedySequenceMap || {})[norm(point)];
    const greedyBadge = greedyStep ? `<div class="driver-order-greedy-mini"><span>Greedy #${greedyStep.step}</span><small>${esc(shortPoint(greedyStep.from))} → ${esc(shortPoint(greedyStep.selected))} · gần nhất ${Number(greedyStep.selectedKm || 0).toFixed(1)}km</small></div>` : '';
    const action = m.next ? `<button class="driver-main-action ${m.next === 'Hoàn tất' ? 'complete' : 'receive'}" type="button" onclick="updateDriverOrderStatus('${esc(id)}','${esc(m.next)}')">${m.btn}</button>` : '';
    return `<article class="driver-order-card-final driver-clean-order-card" data-order-id="${esc(id)}">
      <div class="driver-order-top">
        <div><strong>${esc(id)}</strong><p>${esc(order.customer || 'Khách hàng')} · ${esc(point)}</p></div>
        <span class="driver-status-pill ${m.cls}">${esc(m.label)}</span>
      </div>
      <div class="driver-chip-row">
        <span>⚖ ${kg}kg</span>
        <span>🚚 ${esc(order.shipmentNo || 'SHIP-GV-001')}</span>
        <span>#${Number(order.deliverySequence || 0) || '-'}</span>
        <span>${esc(order.deliveryZone || 'Tuyến giao')}</span>
      </div>
      <div class="driver-progress final-progress"><span style="width:${m.pct}%"></span></div>
      ${greedyBadge}
      <div class="driver-order-destination"><small>Điểm giao</small><b>${esc(point)}</b></div>
      ${action}
    </article>`;
  }

  window.renderDriverOrders = async function renderDriverOrdersFinal() {
    const list = document.getElementById('driverOrdersList');
    if (!list) return;
    if (!isDriver()) {
      list.innerHTML = '<div class="empty-order-cell"><strong>Vui lòng đăng nhập tài khoản tài xế.</strong></div>';
      renderRoute([]);
      updateKpis([]);
      renderHistoryRows([]);
      return;
    }
    list.innerHTML = '<div class="greedy-loading"><span></span>Đang tải đơn tài xế...</div>';
    const raw = await fetchActiveOrders();
    window.__driverRawOrdersCache = raw;
    let rows = mergeActiveState(raw);
    const q = (document.getElementById('driverSearch')?.value || '').toLowerCase().trim();
    if (q) rows = rows.filter(o => Object.values(o || {}).join(' ').toLowerCase().includes(q));
    window.__driverActiveOrders = rows;
    updateKpis(rows);
    renderRoute(rows);
    await renderDeliveredHistory();
    if (!rows.length) {
      list.innerHTML = '<div class="empty-order-cell"><strong>Không còn đơn đang giao.</strong><span>Đơn hoàn tất đã được chuyển qua mục Đơn đã giao.</span></div>';
      return;
    }
    list.innerHTML = `<div class="driver-order-count">${rows.length} đơn đang xử lý</div><div class="driver-final-order-grid">${rows.map(cardHtml).join('')}</div>`;
  };

  window.loadDriverIntegratedGreedy = function () {
    return window.renderDriverOrders();
  };

  window.updateDriverOrderStatus = async function updateDriverOrderStatusFinal(orderId, status) {
    if (!isDriver()) {
      showToast?.('Phải đăng nhập tài khoản tài xế mới cập nhật.', 'warning');
      return;
    }
    const id = String(orderId || '').trim();
    if (!id) return;
    const beforeOrder = (window.__driverActiveOrders || window.__driverRawOrdersCache || []).find(o => getOrderId(o) === id) || { orderId: id };
    const finalStatus = status === 'Tài xế đã nhận' ? 'Đang trên đường đến' : status;

    const map = getMap();
    map[id] = finalStatus;
    setMap(map);
    persistTrackingState({ ...beforeOrder, orderId: id, code: beforeOrder.code || id }, finalStatus);
    if (statusMeta(finalStatus).done) {
      setHidden([...getHidden(), id]);
      pushHistory({ ...beforeOrder, status: 'Hoàn tất', completedAt: new Date().toISOString() });
    }

    // Cập nhật ngay trên giao diện trước, không để card bị đứng yên sau khi bấm.
    await window.renderDriverOrders();

    try {
      const res = await fetch(`${API}/orders/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({
          status: finalStatus,
          note: finalStatus === 'Hoàn tất'
            ? 'Tài xế đã giao xong, đơn được lưu vào lịch sử đã giao.'
            : 'Tài xế đã nhận đơn và đang trên đường đến điểm giao.'
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'Không cập nhật được trạng thái.');
      if (data.order) persistTrackingState({ ...data.order, orderId: id, code: data.order.code || id }, finalStatus);
      if (statusMeta(finalStatus).done && data.order) pushHistory({ ...data.order, completedAt: new Date().toISOString() });
      showToast?.(finalStatus === 'Hoàn tất' ? `Đã hoàn tất ${id}. Đơn đã chuyển qua mục Đơn đã giao và tra cứu cũng hiện Hoàn tất.` : `Đã nhận ${id}. Trạng thái: Đang trên đường đến.`, 'success');
    } catch (error) {
      showToast?.(error.message || 'Đã cập nhật tạm trên giao diện.', 'warning');
    }
    setTimeout(() => window.renderDriverOrders(), 350);
  };

  window.addEventListener('DOMContentLoaded', () => setTimeout(() => window.renderDriverOrders(), 450));
})();
