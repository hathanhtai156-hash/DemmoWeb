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

  function renderRoute(rows) {
    const box = document.getElementById('driverGreedyIntegrated');
    if (!box) return;
    if (!rows.length) {
      box.innerHTML = '<div class="empty-greedy-driver">Không còn tuyến đang giao. Đơn đã hoàn tất nằm ở mục “Đơn đã giao”.</div>';
      return;
    }
    const depot = 'Kho LogiPort Bình Thạnh';
    const stops = [];
    rows.forEach(o => {
      const point = o.deliveryPoint || o.address || '';
      if (point && !stops.some(x => norm(x) === norm(point))) stops.push(point);
    });
    const route = [depot, ...stops];
    const stepHtml = route.slice(0, -1).map((from, index) => {
      const to = route[index + 1];
      const km = Number(rows[index]?.estimatedKm || 0) || (index === 0 ? 7.9 : 0.6);
      return `<article class="driver-final-step">
        <b>${index + 1}</b>
        <div><small>Từ</small><strong>${esc(from)}</strong></div>
        <i>→</i>
        <div><small>Đến</small><strong>${esc(to)}</strong></div>
        <em>${km.toFixed(1)}km</em>
      </article>`;
    }).join('');
    box.innerHTML = `<section class="driver-final-route">
      <div class="driver-final-route-head">
        <div><span>Tuyến giao hôm nay</span><h2>Đi theo thứ tự Greedy, hoàn tất đơn nào thì đơn đó tự rời danh sách</h2></div>
        <strong>${stops.length} điểm</strong>
      </div>
      <div class="driver-final-pills">${route.map((p, i) => `<span class="${i === 0 ? 'depot' : ''}">${i === 0 ? 'Kho' : '#' + i} · ${esc(p)}</span>`).join('<i>→</i>')}</div>
      <div class="driver-final-steps">${stepHtml}</div>
    </section>`;
  }

  function cardHtml(order) {
    const id = getOrderId(order);
    const point = order.deliveryPoint || order.address || 'Điểm giao';
    const m = statusMeta(order.status);
    const kg = Number(order.totalWeightKg || order.weightKg || 0).toFixed(1);
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
