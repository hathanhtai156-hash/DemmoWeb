const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'logiport_demo_secret';
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, 'database.sqlite');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname)));

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Could not open SQLite database:', err);
    process.exit(1);
  }
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve(this);
  });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

const rolePermissions = {
  admin: ['manage_users', 'view_reports', 'manage_products', 'approve_orders', 'assign_orders', 'view_products', 'view_orders'],
  staff: ['manage_products', 'approve_orders', 'view_orders', 'view_products'],
  driver: ['view_orders', 'accept_orders'],
  customer: ['view_products', 'create_orders']
};


function normalizeProductKeyword(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .trim();
}

function isValidImageSource(value = '') {
  const src = String(value || '').trim();
  if (!src) return false;
  if (/^data:image\//i.test(src)) return true;
  if (/^https?:\/\//i.test(src)) return true;
  if (/^(images|assets)\//i.test(src) && /\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(src)) return true;
  return false;
}

function defaultProductImageByNameOrCategory(name = '', category = '') {
  const text = `${normalizeProductKeyword(name)} ${normalizeProductKeyword(category)}`;
  // Ưu tiên theo tên sản phẩm trước, tránh trường hợp "balo laptop" bị nhận thành laptop.
  if (/(ban phim|keyboard|phim co|rgb)/.test(text)) return 'images/keyboard.png';
  if (/(chuot|mouse)/.test(text)) return 'images/mouse.png';
  if (/(tai nghe|headphone|audio|bluetooth|chong on)/.test(text)) return 'images/headphone.png';
  if (/(dien thoai|phone|iphone|mobile|5g)/.test(text)) return 'images/phone.png';
  if (/(balo|backpack|cap sach)/.test(text)) return 'images/backpack.png';
  if (/(tui|xach|bag|duffle|tote)/.test(text)) return 'images/bag.png';
  if (/(ao|shirt|thun|vo dich|t1|clothing|fashion)/.test(text)) return 'images/tshirt.png';
  if (/(quan|jeans|denim|cargo)/.test(text)) return 'images/jeans.png';
  if (/(giay|sneaker|shoes|nike)/.test(text)) return 'images/shoes.png';
  if (/(laptop|notebook|may tinh)/.test(text)) return 'images/laptop.png';
  if (/(pallet)/.test(text)) return 'images/pallet-wood.webp';
  if (/(thung|carton|hop giay)/.test(text)) return 'images/carton-box.jpg';
  if (/(mang pe|pe film|tui khi|chong soc)/.test(text)) return 'images/pe-film.jpg';
  if (/(tem nhan|nhan|label|ma van don)/.test(text)) return 'images/label-printer.jpg';
  if (/(bo dung cu|dong dai|day dai|strapping)/.test(text)) return 'images/strapping-tool.jpg';
  if (/(xe container|xe tai|truck)/.test(text)) return 'images/model-truck-maersk.webp';
  if (/(bo xep hinh|lego|xe nang)/.test(text)) return 'images/lego-city-truck.webp';
  if (/(gau bong|mascot)/.test(text)) return 'images/mascot-delivery.jpg';
  if (/(mo hinh|model|tau|ship|container|may bay|moc khoa)/.test(text)) return 'images/model-ship-maersk.webp';
  if (/(quat)/.test(text)) return 'images/fan-stand.jpg';
  if (/(may xay|xay sinh to|blender)/.test(text)) return 'images/blender.jpg';
  if (/(ghe|chair|cong thai hoc|van phong)/.test(text)) return 'images/chair.PNG';
  if (/(nem|sofa|ke)/.test(text)) return 'images/folding-sofa.jpg';
  if (/(gia dung|noi|den|am sieu toc)/.test(text)) return 'images/home-appliance-set.jpg';
  return 'images/laptop.png';
}



// Kho xuất phát dùng địa chỉ thật để Google Maps dựng tuyến có ý nghĩa hơn.
const DELIVERY_WAREHOUSE = '69 Nguyễn Gia Trí, Phường 25, Bình Thạnh, TP.HCM';
const TRUCK_CAPACITY_KG = 100;
const MAX_ORDERS_PER_TRIP = 100; // Giới hạn số đơn trong một chuyến demo, mô phỏng gom 100 đơn trước khi chạy Greedy.
const DRIVER_POOL = ['Tài xế Demo'];
// Bản demo chỉ dùng 1 tài xế duy nhất để tránh chia đơn qua nhiều acc khác nhau.
// Các khu vẫn được tách thành nhiều chuyến riêng, nhưng tất cả gán về acc: taixe / tx123456.
const ZONE_DRIVER_MAP = {
  'Tuyến Gò Vấp': 'Tài xế Demo',
  'Tuyến Bình Thạnh': 'Tài xế Demo',
  'Tuyến Tân Bình': 'Tài xế Demo',
  'Tuyến Thủ Đức': 'Tài xế Demo',
  'Tuyến Trung tâm': 'Tài xế Demo',
  'Tuyến Nam Sài Gòn': 'Tài xế Demo',
  'Tuyến Bình Tân': 'Tài xế Demo',
  'Tuyến Bình Dương': 'Tài xế Demo',
  'Khu Đông': 'Tài xế Demo',
  'Khu Bắc': 'Tài xế Demo',
  'Khu Nam': 'Tài xế Demo',
  'Khu Tây': 'Tài xế Demo',
  'Khu Trung tâm': 'Tài xế Demo',
  'Liên tỉnh': 'Tài xế Demo',
  'Khác': 'Tài xế Demo'
};
const DRIVER_ROUTE_HINTS = {
  'Tài xế Demo': ['nguyễn thái sơn', 'quang trung', 'phan văn trị', 'hoàng văn thụ', 'cộng hòa', 'bạch đằng', 'nguyễn gia trí', 'điện biên phủ', 'lê văn việt', 'võ văn ngân', 'mai chí thọ', 'cát lái', 'nguyễn huệ', 'lê lợi', 'nguyễn thị minh khai', 'lý thường kiệt', 'võ văn kiệt', 'nguyễn văn linh', 'huỳnh tấn phát', 'nguyễn hữu thọ', 'nhà bè', 'tên lửa', 'kinh dương vương', 'tân tạo', 'bình tân']
};

// Điểm giao chi tiết theo số nhà + đường. Không dùng chung chung kiểu “Gò Vấp/Bình Thạnh” nữa.
// x/y là tọa độ demo nội bộ để thuật toán Greedy chọn điểm gần nhất; Google Maps vẫn dùng label địa chỉ thật.
const DELIVERY_POINTS = [
  { key: 'nguyen gia tri', label: '69/1 Nguyễn Gia Trí, Phường 25, Bình Thạnh, TP.HCM', district: 'Bình Thạnh', zone: 'Khu Bắc', x: 7.2, y: 7.1 },
  { key: 'dien bien phu binh thanh', label: '475 Điện Biên Phủ, Phường 25, Bình Thạnh, TP.HCM', district: 'Bình Thạnh', zone: 'Khu Bắc', x: 7.0, y: 6.8 },
  { key: 'bach dang binh thanh', label: '220 Bạch Đằng, Phường 24, Bình Thạnh, TP.HCM', district: 'Bình Thạnh', zone: 'Khu Bắc', x: 7.5, y: 7.4 },
  { key: 'nguyen thai son', label: '315 Nguyễn Thái Sơn, Phường 5, Gò Vấp, TP.HCM', district: 'Gò Vấp', zone: 'Khu Bắc', x: 5.8, y: 9.6 },
  { key: 'quang trung go vap', label: '77 Quang Trung, Phường 10, Gò Vấp, TP.HCM', district: 'Gò Vấp', zone: 'Khu Bắc', x: 5.5, y: 10.2 },
  { key: 'phan van tri', label: '399 Phan Văn Trị, Phường 5, Gò Vấp, TP.HCM', district: 'Gò Vấp', zone: 'Khu Bắc', x: 5.9, y: 9.9 },
  { key: 'le van viet', label: '12 Lê Văn Việt, Hiệp Phú, TP Thủ Đức, TP.HCM', district: 'TP Thủ Đức', zone: 'Khu Đông', x: 13.0, y: 8.0 },
  { key: 'vo van ngan', label: '168 Võ Văn Ngân, Linh Chiểu, TP Thủ Đức, TP.HCM', district: 'TP Thủ Đức', zone: 'Khu Đông', x: 12.4, y: 8.7 },
  { key: 'mai chi tho', label: '88 Mai Chí Thọ, An Phú, TP Thủ Đức, TP.HCM', district: 'TP Thủ Đức', zone: 'Khu Đông', x: 10.8, y: 6.8 },
  { key: 'nguyen hue', label: '25 Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM', district: 'Quận 1', zone: 'Khu Trung tâm', x: 6.1, y: 5.0 },
  { key: 'le loi quan 1', label: '45 Lê Lợi, Bến Nghé, Quận 1, TP.HCM', district: 'Quận 1', zone: 'Khu Trung tâm', x: 5.9, y: 5.2 },
  { key: 'nguyen thi minh khai', label: '88 Nguyễn Thị Minh Khai, Phường Võ Thị Sáu, Quận 3, TP.HCM', district: 'Quận 3', zone: 'Khu Trung tâm', x: 5.2, y: 5.6 },
  { key: 'ly thuong kiet', label: '102 Lý Thường Kiệt, Phường 14, Quận 10, TP.HCM', district: 'Quận 10', zone: 'Khu Trung tâm', x: 4.3, y: 6.0 },
  { key: 'vo van kiet', label: '35 Võ Văn Kiệt, Phường 6, Quận 5, TP.HCM', district: 'Quận 5', zone: 'Khu Trung tâm', x: 4.2, y: 4.4 },
  { key: 'hoang van thu', label: '41 Hoàng Văn Thụ, Phường 15, Tân Bình, TP.HCM', district: 'Tân Bình', zone: 'Khu Bắc', x: 3.4, y: 8.1 },
  { key: 'cong hoa', label: '250 Cộng Hòa, Phường 12, Tân Bình, TP.HCM', district: 'Tân Bình', zone: 'Khu Bắc', x: 3.0, y: 8.5 },
  { key: 'nguyen van linh quan 7', label: '19 Nguyễn Văn Linh, Tân Phú, Quận 7, TP.HCM', district: 'Quận 7', zone: 'Khu Nam', x: 6.0, y: 1.4 },
  { key: 'huynh tan phat', label: '510 Huỳnh Tấn Phát, Tân Thuận Đông, Quận 7, TP.HCM', district: 'Quận 7', zone: 'Khu Nam', x: 6.8, y: 1.0 },
  { key: 'nguyen huu tho', label: '280 Nguyễn Hữu Thọ, Phước Kiển, Nhà Bè, TP.HCM', district: 'Nhà Bè', zone: 'Khu Nam', x: 7.2, y: 0.4 },
  { key: 'ten lua', label: '32 Đường Số 7, Khu Tên Lửa, Bình Tân, TP.HCM', district: 'Bình Tân', zone: 'Khu Tây', x: 1.3, y: 5.3 },
  { key: 'kinh duong vuong', label: '621 Kinh Dương Vương, An Lạc, Bình Tân, TP.HCM', district: 'Bình Tân', zone: 'Khu Tây', x: 1.0, y: 4.8 },
  { key: 'kcn tan tao', label: 'Lô 12 KCN Tân Tạo, Bình Tân, TP.HCM', district: 'Bình Tân', zone: 'Khu Tây', x: 0.4, y: 4.1 },
  { key: 'cat lai', label: 'Cảng Cát Lái, Nguyễn Thị Định, TP Thủ Đức, TP.HCM', district: 'TP Thủ Đức', zone: 'Khu Đông', x: 9.1, y: 8.2 },
  { key: 'song than', label: 'KCN Sóng Thần, Dĩ An, Bình Dương', district: 'Bình Dương', zone: 'Liên tỉnh', x: 11.0, y: 11.2 },
  { key: 'dai lo binh duong', label: '550 Đại lộ Bình Dương, Thủ Dầu Một, Bình Dương', district: 'Bình Dương', zone: 'Liên tỉnh', x: 12.4, y: 12.0 }
];
const DISTRICT_FALLBACK_POINTS = [
  { key: 'binh thanh', ref: 'nguyen gia tri' }, { key: 'go vap', ref: 'nguyen thai son' }, { key: 'thu duc', ref: 'le van viet' },
  { key: 'quan 1', ref: 'nguyen hue' }, { key: 'quan 3', ref: 'nguyen thi minh khai' }, { key: 'quan 10', ref: 'ly thuong kiet' },
  { key: 'quan 5', ref: 'vo van kiet' }, { key: 'tan binh', ref: 'hoang van thu' }, { key: 'quan 7', ref: 'nguyen van linh quan 7' },
  { key: 'nha be', ref: 'nguyen huu tho' }, { key: 'binh tan', ref: 'ten lua' }, { key: 'tan tao', ref: 'kcn tan tao' },
  { key: 'binh duong', ref: 'song than' }
];
const WAREHOUSE_POINT = { label: DELIVERY_WAREHOUSE, zone: 'Kho', x: 7.2, y: 7.1 };

function stripVietnamese(value = '') {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
}

function getProductWeightKg(item = {}) {
  const text = stripVietnamese(`${item.id || ''} ${item.name || ''} ${item.category || ''}`);
  if (/pallet/.test(text)) return 25;
  if (/thung|carton/.test(text)) return 2;
  if (/laptop|rog/.test(text)) return 3.2;
  if (/iphone|dien thoai|phone/.test(text)) return 0.35;
  if (/ban phim|keyboard|leobog/.test(text)) return 1.1;
  if (/chuot|mouse/.test(text)) return 0.25;
  if (/tai nghe|headphone/.test(text)) return 0.7;
  if (/ao|shirt|thun/.test(text)) return 0.35;
  if (/quan|jeans|cargo/.test(text)) return 0.8;
  if (/giay|shoes|nike/.test(text)) return 1.2;
  if (/balo|backpack/.test(text)) return 1.3;
  if (/tui|bag|trong/.test(text)) return 1.1;
  if (/model|mo hinh|gau bong|mascot/.test(text)) return 0.8;
  return 1;
}

function parseOrderItems(row = {}) {
  try {
    if (Array.isArray(row.items)) return row.items;
    return row.items ? JSON.parse(row.items) : [];
  } catch {
    return [];
  }
}

function calculateOrderWeightKg(items = []) {
  const total = items.reduce((sum, item) => sum + getProductWeightKg(item) * Number(item.quantity || 1), 0);
  return Number(Math.max(0.1, total).toFixed(1));
}

function getAddressSequenceOffset(address = '') {
  const nums = String(address || '').match(/\d+/g) || [];
  const last = Number(nums[nums.length - 1] || nums[0] || 0);
  // Offset nhỏ để các số nhà liền nhau vẫn là các điểm khác nhau trên tuyến Greedy.
  return ((last % 17) - 8) * 0.035;
}

function normalizeDeliveryZone(point = {}, address = '') {
  const text = stripVietnamese(`${address} ${point.district || ''} ${point.label || ''}`);
  if (/go vap|nguyen thai son|quang trung|phan van tri|nguyen oanh|le duc tho/.test(text)) return 'Tuyến Gò Vấp';
  if (/binh thanh|nguyen gia tri|dien bien phu|bach dang|ung van khiem|xo viet nghe tinh/.test(text)) return 'Tuyến Bình Thạnh';
  if (/tan binh|cong hoa|hoang van thu|truong chinh|ut tich/.test(text)) return 'Tuyến Tân Bình';
  if (/thu duc|le van viet|vo van ngan|mai chi tho|cat lai|nguyen thi dinh|kha van can/.test(text)) return 'Tuyến Thủ Đức';
  if (/quan 1|quan 3|quan 5|quan 10|nguyen hue|le loi|nguyen thi minh khai|ly thuong kiet|vo van kiet/.test(text)) return 'Tuyến Trung tâm';
  if (/quan 7|nha be|nguyen van linh|huynh tan phat|nguyen huu tho/.test(text)) return 'Tuyến Nam Sài Gòn';
  if (/binh tan|ten lua|kinh duong vuong|tan tao/.test(text)) return 'Tuyến Bình Tân';
  if (/binh duong|song than|di an|thu dau mot/.test(text)) return 'Tuyến Bình Dương';
  return point.zone || 'Tuyến khác';
}

function withRealAddressLabel(point = {}, address = '') {
  const raw = String(address || '').trim();
  const detailed = /\d/.test(raw) && raw.length > 15;
  const offset = getAddressSequenceOffset(raw);
  return {
    ...point,
    label: detailed ? raw : (point.label || raw || 'Chưa xác định'),
    zone: normalizeDeliveryZone(point, raw),
    x: Number((Number(point.x || 0) + offset).toFixed(3)),
    y: Number((Number(point.y || 0) + offset * 0.6).toFixed(3))
  };
}

function inferDeliveryPoint(address = '') {
  const original = String(address || '').trim();
  const text = stripVietnamese(original);
  // Ưu tiên khớp tuyến đường/khu vực, nhưng giữ nguyên số nhà thật để không bị gom trùng địa chỉ.
  const specific = DELIVERY_POINTS.find(point => text.includes(point.key));
  if (specific) return withRealAddressLabel(specific, original);
  const fallback = DISTRICT_FALLBACK_POINTS.find(item => text.includes(item.key));
  if (fallback) {
    const point = DELIVERY_POINTS.find(p => p.key === fallback.ref) || DELIVERY_POINTS[0];
    return withRealAddressLabel(point, original || point.label);
  }
  const checksum = [...text].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return withRealAddressLabel(DELIVERY_POINTS[checksum % DELIVERY_POINTS.length], original);
}

function preferSpecificDeliveryPoint(storedPoint = '', inferredPoint = {}) {
  const stored = String(storedPoint || '').trim();
  // Điểm cũ kiểu “Gò Vấp”, “Bình Thạnh”, “Quận 1” không đủ để Maps chạy thực tế.
  const isDetailed = /\d/.test(stored) && stored.length > 20;
  return isDetailed ? stored : (inferredPoint.label || stored || 'Chưa xác định');
}

function distanceKm(a, b) {
  const labelA = stripVietnamese(a.label || a.deliveryPoint || '');
  const labelB = stripVietnamese(b.label || b.deliveryPoint || '');
  // Cùng một địa chỉ/điểm giao thì không cộng thêm km.
  if (labelA && labelB && labelA === labelB) return 0;
  const dx = Number(a.x || 0) - Number(b.x || 0);
  const dy = Number(a.y || 0) - Number(b.y || 0);
  // Tọa độ demo nội bộ theo TP.HCM, hệ số quy đổi giữ km ở mức thực tế nội thành.
  return Number(Math.max(0.6, Math.sqrt(dx * dx + dy * dy) * 2.75).toFixed(1));
}

function buildGreedyDeliveryRoute(deliveries = []) {
  // Gom các đơn trùng địa chỉ thành một điểm dừng, Greedy chạy trên điểm dừng chứ không chạy từng dòng đơn.
  // Nhờ vậy tuyến không bị phồng km khi có 20 đơn cùng một đường Lý Thường Kiệt.
  const groups = new Map();
  for (const item of deliveries) {
    const point = item.point || inferDeliveryPoint(item.address || item.deliveryPoint || '');
    const key = stripVietnamese(point.label || item.deliveryPoint || item.address || '');
    if (!groups.has(key)) {
      groups.set(key, { point, orders: [], totalWeightKg: 0 });
    }
    const group = groups.get(key);
    group.orders.push({ ...item, point });
    group.totalWeightKg += Number(item.weightKg || item.totalWeightKg || 0);
  }

  const remaining = Array.from(groups.values());
  const orderedStops = [];
  const greedySteps = [];
  let current = WAREHOUSE_POINT;
  let km = 0;

  while (remaining.length) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    let candidates = [];
    remaining.forEach((stop, index) => {
      const d = distanceKm(current, stop.point || current);
      candidates.push({ label: stop.point?.label || 'Điểm giao', km: Number(d.toFixed(1)), ordersCount: stop.orders?.length || 1 });
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = index;
      }
    });
    candidates = candidates.sort((a, b) => a.km - b.km).slice(0, 5);
    const nextStop = remaining.splice(bestIndex, 1)[0];
    km += bestDistance;
    const step = {
      step: orderedStops.length + 1,
      from: current.label || DELIVERY_WAREHOUSE,
      selected: nextStop.point?.label || 'Điểm giao',
      selectedKm: Number(bestDistance.toFixed(1)),
      candidates,
      reason: `Chọn điểm gần nhất trong ${candidates.length} ứng viên gần nhất theo khoảng cách demo nội thành.`
    };
    greedySteps.push(step);
    orderedStops.push({ ...nextStop, stepKm: Number(bestDistance.toFixed(1)), greedyStep: step });
    current = nextStop.point || current;
  }

  // Không ép xe quay lại kho 100%, chỉ cộng 15% để thể hiện phát sinh kết thúc tuyến.
  const returnKm = Number((distanceKm(current, WAREHOUSE_POINT) * 0.15).toFixed(1));
  km += returnKm;

  const route = [];
  orderedStops.forEach((stop, stopIndex) => {
    stop.orders.forEach((order, orderIndex) => {
      route.push({
        ...order,
        deliverySequence: stopIndex + 1,
        stopOrderIndex: orderIndex + 1,
        stopOrdersCount: stop.orders.length,
        stepKm: stop.stepKm,
        stopWeightKg: Number(stop.totalWeightKg.toFixed(1))
      });
    });
  });

  return {
    route,
    stops: orderedStops.map((stop, index) => ({
      sequence: index + 1,
      label: stop.point.label,
      zone: stop.point.zone,
      ordersCount: stop.orders.length,
      totalWeightKg: Number(stop.totalWeightKg.toFixed(1)),
      stepKm: stop.stepKm
    })),
    greedySteps,
    returnKm,
    estimatedKm: Number(km.toFixed(1))
  };
}

function enrichOrderForDelivery(row = {}) {
  const order = normalizeOrderRow ? normalizeOrderRow(row) : row;
  const items = parseOrderItems(row);
  const weight = Number(row.totalWeightKg || row.weightKg || calculateOrderWeightKg(items));
  const point = inferDeliveryPoint(order.address || order.route || '');
  return {
    ...order,
    items,
    weightKg: Number(weight.toFixed ? weight.toFixed(1) : Number(weight || 1).toFixed(1)),
    deliveryPoint: preferSpecificDeliveryPoint(row.deliveryPoint, point),
    deliveryZone: row.deliveryZone || point.zone,
    point,
    shipmentNo: row.shipmentNo || '',
    deliverySequence: Number(row.deliverySequence || 0),
    greedyRoute: row.greedyRoute || '',
    estimatedKm: Number(row.estimatedKm || 0)
  };
}

function canGoToTruck(order = {}) {
  const s = String(order.status || '').toLowerCase();
  return ['đã duyệt', 'dang dong goi', 'đang đóng gói', 'sẵn sàng giao', 'san sang giao', 'đã phân công', 'da phan cong', 'tài xế đã nhận', 'tai xe da nhan', 'đang giao', 'dang giao', 'đang vận chuyển', 'dang van chuyen'].some(x => stripVietnamese(s).includes(stripVietnamese(x)));
}

function buildShopeeMiniPlanFromRows(rows = []) {
  const enriched = rows.map(enrichOrderForDelivery).filter(order => !String(order.status || '').toLowerCase().includes('hoàn'));
  const ready = enriched.filter(canGoToTruck);
  const blocked = enriched.filter(order => !canGoToTruck(order));
  const byZone = ready.reduce((map, order) => {
    const zone = order.deliveryZone || 'Khác';
    if (!map[zone]) map[zone] = [];
    map[zone].push(order);
    return map;
  }, {});
  const loads = [];
  Object.entries(byZone).sort(([a], [b]) => a.localeCompare(b, 'vi')).forEach(([zone, list]) => {
    // Giai đoạn 1 - Order Batching: lọc các đơn cùng khu, rồi dùng Greedy sơ bộ để gom những điểm gần nhau trước.
    const ordered = buildGreedyDeliveryRoute(list).route;
    let currentLoad = [];
    let currentWeight = 0;
    ordered.forEach(order => {
      const weight = Number(order.weightKg || 1);
      const overWeight = currentLoad.length && currentWeight + weight > TRUCK_CAPACITY_KG;
      const overOrderLimit = currentLoad.length >= MAX_ORDERS_PER_TRIP;
      if (overWeight || overOrderLimit) {
        const greedy = buildGreedyDeliveryRoute(currentLoad);
        loads.push({
          zone,
          orders: greedy.route,
          stops: greedy.stops,
          greedySteps: greedy.greedySteps,
          returnKm: greedy.returnKm,
          totalWeightKg: Number(currentWeight.toFixed(1)),
          estimatedKm: greedy.estimatedKm,
          batchingReason: overWeight ? 'Tách chuyến vì vượt tải 100kg.' : 'Tách chuyến vì đủ 100 đơn demo.'
        });
        currentLoad = [];
        currentWeight = 0;
      }
      currentLoad.push(order);
      currentWeight += weight;
    });
    if (currentLoad.length) {
      const greedy = buildGreedyDeliveryRoute(currentLoad);
      loads.push({
        zone,
        orders: greedy.route,
        stops: greedy.stops,
        greedySteps: greedy.greedySteps,
        returnKm: greedy.returnKm,
        totalWeightKg: Number(currentWeight.toFixed(1)),
        estimatedKm: greedy.estimatedKm,
        batchingReason: 'Chuyến cuối của khu, chưa vượt tải.'
      });
    }
  });
  loads.forEach((load, index) => {
    load.loadNo = `CHUYEN-${String(index + 1).padStart(3, '0')}`;
    load.driver = chooseDriverForLoad(load, index);
    load.vehicle = 'Xe tải 1 tấn - tải tối đa 100kg';
    load.capacityKg = TRUCK_CAPACITY_KG;
    load.maxOrders = MAX_ORDERS_PER_TRIP;
    load.routeText = [DELIVERY_WAREHOUSE, ...(load.stops || []).map(stop => stop.label)].filter(Boolean).join(' → ');
    load.orders = load.orders.map((order, orderIndex) => ({ ...order, shipmentNo: load.loadNo, deliverySequence: orderIndex + 1, driver: order.driver || load.driver }));
  });
  return {
    capacityKg: TRUCK_CAPACITY_KG,
    maxOrdersPerTrip: MAX_ORDERS_PER_TRIP,
    warehouse: DELIVERY_WAREHOUSE,
    totalOrders: enriched.length,
    readyOrders: ready.length,
    blockedOrders: blocked.length,
    loads,
    blocked: blocked.slice(0, 50),
    summary: {
      totalLoads: loads.length,
      totalWeightKg: Number(ready.reduce((sum, order) => sum + Number(order.weightKg || 0), 0).toFixed(1)),
      estimatedKm: Number(loads.reduce((sum, load) => sum + Number(load.estimatedKm || 0), 0).toFixed(1)),
      zones: Object.keys(byZone).length
    }
  };
}


function chooseDriverForLoad(load = {}, fallbackIndex = 0) {
  // Demo dùng một tài xế duy nhất để acc taixe luôn thấy đơn sau khi điều phối.
  return 'Tài xế Demo';
}

async function runAutoWarehouseAndDispatch({ orderId = null, actor = 'Hệ thống' } = {}) {
  const updatedAt = new Date().toISOString();
  // Kho chạy tự động: đơn vừa duyệt sẽ được đóng gói, cân khối lượng và chuyển sẵn sàng giao.
  let readyParams = [updatedAt, actor];
  let readyWhere = `status IN ('Đã duyệt', 'Đang xử lý', 'Đang đóng gói')`;
  if (orderId) {
    readyWhere += ' AND orderId = ?';
    readyParams.push(orderId);
  }
  await dbRun(
    `UPDATE orders
     SET status = 'Sẵn sàng giao',
         currentLocation = ?,
         staffInCharge = 'Kho tự động',
         note = 'Kho tự động đã kiểm tồn, đóng gói và cân hàng. Chuyển qua điều phối.',
         updatedAt = ?
     WHERE ${readyWhere}`,
    [DELIVERY_WAREHOUSE, updatedAt, ...readyParams.slice(2)]
  );

  // Điều phối tự động: gom đơn tối đa 100kg, chia chuyến theo khu/tuyến và gán tài xế.
  const rows = await dbAll('SELECT * FROM orders ORDER BY createdAt ASC');
  const plan = buildShopeeMiniPlanFromRows(rows);
  let assigned = 0;
  for (const load of plan.loads) {
    for (const order of load.orders) {
      if (orderId && order.orderId !== orderId) continue;
      const current = await dbGet('SELECT status FROM orders WHERE orderId = ?', [order.orderId]);
      if (!current || !canGoToTruck(current)) continue;
      await dbRun(
        `UPDATE orders SET driver = ?, vehicle = ?, route = ?, status = ?, currentLocation = ?, note = ?, shipmentNo = ?, deliverySequence = ?, greedyRoute = ?, estimatedKm = ?, totalWeightKg = ?, deliveryPoint = ?, deliveryZone = ?, updatedAt = ? WHERE orderId = ?`,
        [load.driver, load.vehicle, load.routeText, 'Đã phân công', DELIVERY_WAREHOUSE, `Kho + Điều phối tự động: gom vào ${load.loadNo} (${load.totalWeightKg}/${TRUCK_CAPACITY_KG}kg), gán ${load.driver}, tuyến Greedy ${load.estimatedKm}km.`, load.loadNo, order.deliverySequence, load.routeText, load.estimatedKm, order.weightKg, order.deliveryPoint, order.deliveryZone, updatedAt, order.orderId]
      );
      assigned += 1;
    }
  }
  const freshRows = await dbAll('SELECT * FROM orders ORDER BY createdAt DESC');
  return { assigned, plan: buildShopeeMiniPlanFromRows(freshRows) };
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token không được cung cấp.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Token không hợp lệ.' });
    req.user = user;
    next();
  });
}

function authorizeRole(requiredRoles) {
  return (req, res, next) => {
    if (!req.user || !requiredRoles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Bạn không có quyền truy cập.' });
    }
    next();
  };
}


function publicUser(row = {}) {
  return {
    id: row.id,
    username: row.username,
    role: row.role || 'customer',
    displayName: row.displayName || row.username || 'Khách hàng',
    email: row.email || '',
    phone: row.phone || '',
    address: row.address || '',
    companyName: row.companyName || '',
    taxCode: row.taxCode || '',
    customerCode: row.customerCode || '',
    note: row.note || '',
    updatedAt: row.updatedAt || ''
  };
}

function customerTxtLine(user = {}) {
  const safe = (value = '') => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return [
    safe(user.customerCode),
    safe(user.displayName),
    safe(user.username),
    safe(user.role),
    safe(user.email),
    safe(user.phone),
    safe(user.companyName),
    safe(user.taxCode),
    safe(user.address),
    safe(user.note),
    safe(user.updatedAt)
  ].join(' | ');
}

app.get('/', (req, res) => {
  res.json({ message: 'LogiPort backend is running' });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: 'Vui lòng cung cấp username và password.' });
  }

  const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ message: 'Username hoặc password không đúng.' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, displayName: user.displayName },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({ token, user: publicUser(user) });
});


function buildDemoOrder(index, customerUserId = '') {
  const pad = String(index).padStart(3, '0');
  const products = [
    { id: 'p-keyboard', name: 'Bàn phím cơ LEOBOG K81 RGB LovKey', price:1290000, image: 'images/keyboard.png' },
    { id: 'p-mouse', name: 'Chuột gaming không dây T1 TogeTH', price:690000, image: 'images/mouse.png' },
    { id: 'p-laptop', name: 'Laptop gaming ASUS ROG Strix RGB', price:36990000, image: 'images/laptop.png' },
    { id: 'p-headphone', name: 'Tai nghe gaming RGB có mic chống ồn', price:890000, image: 'images/headphone.png' },
    { id: 'p-phone', name: 'iPhone 17 Pro màu cam chính hãng', price:31990000, image: 'images/phone.png' },
    { id: 'p-shirt', name: 'Áo thun T1 Worlds 2020 oversize', price:350000, image: 'images/tshirt.png' },
    { id: 'p-jeans', name: 'Quần jeans cargo ống rộng streetwear', price:420000, image: 'images/jeans.png' },
    { id: 'p-shoes', name: 'Giày Nike Phantom GX sân cỏ nhân tạo', price:1590000, image: 'images/shoes.png' },
    { id: 'p-bag', name: 'Túi trống T1 du lịch thể thao', price:450000, image: 'images/bag.png' },
    { id: 'p-backpack', name: 'Balo T1 gaming backpack chống nước', price:520000, image: 'images/backpack.png' }
  ];
  const customers = [
    'Nguyễn Văn An', 'Trần Minh Anh', 'Lê Thảo Nhi', 'Phạm Gia Hân', 'Hoàng Quốc Bảo',
    'Đặng Thanh Tùng', 'Võ Ngọc Mai', 'Bùi Khánh Linh', 'Đỗ Nhật Minh', 'Huỳnh Tuấn Kiệt',
    'Ngô Phương Uyên', 'Mai Đức Long', 'Trương Mỹ Duyên', 'Phan Hoài Nam', 'Cao Minh Khang'
  ];
  const addresses = [
    '566/197/52 Nguyễn Thái Sơn, Phường 5, Gò Vấp, TP.HCM',
    '566/197/53 Nguyễn Thái Sơn, Phường 5, Gò Vấp, TP.HCM',
    '566/197/54 Nguyễn Thái Sơn, Phường 5, Gò Vấp, TP.HCM',
    '566/197/55 Nguyễn Thái Sơn, Phường 5, Gò Vấp, TP.HCM',
    '566/197/56 Nguyễn Thái Sơn, Phường 5, Gò Vấp, TP.HCM',
    '566/197/57 Nguyễn Thái Sơn, Phường 5, Gò Vấp, TP.HCM',
    '566/197/58 Nguyễn Thái Sơn, Phường 5, Gò Vấp, TP.HCM',
    '566/197/59 Nguyễn Thái Sơn, Phường 5, Gò Vấp, TP.HCM',
    '566/197/60 Nguyễn Thái Sơn, Phường 5, Gò Vấp, TP.HCM',
    '566/197/61 Nguyễn Thái Sơn, Phường 5, Gò Vấp, TP.HCM',
    '77 Quang Trung, Phường 10, Gò Vấp, TP.HCM',
    '79 Quang Trung, Phường 10, Gò Vấp, TP.HCM',
    '81 Quang Trung, Phường 10, Gò Vấp, TP.HCM',
    '83 Quang Trung, Phường 10, Gò Vấp, TP.HCM',
    '85 Quang Trung, Phường 10, Gò Vấp, TP.HCM',
    '87 Quang Trung, Phường 10, Gò Vấp, TP.HCM',
    '89 Quang Trung, Phường 10, Gò Vấp, TP.HCM',
    '91 Quang Trung, Phường 10, Gò Vấp, TP.HCM',
    '93 Quang Trung, Phường 10, Gò Vấp, TP.HCM',
    '95 Quang Trung, Phường 10, Gò Vấp, TP.HCM',
    '69/1 Nguyễn Gia Trí, Phường 25, Bình Thạnh, TP.HCM',
    '69/3 Nguyễn Gia Trí, Phường 25, Bình Thạnh, TP.HCM',
    '69/5 Nguyễn Gia Trí, Phường 25, Bình Thạnh, TP.HCM',
    '69/7 Nguyễn Gia Trí, Phường 25, Bình Thạnh, TP.HCM',
    '69/9 Nguyễn Gia Trí, Phường 25, Bình Thạnh, TP.HCM',
    '69/11 Nguyễn Gia Trí, Phường 25, Bình Thạnh, TP.HCM',
    '69/13 Nguyễn Gia Trí, Phường 25, Bình Thạnh, TP.HCM',
    '69/15 Nguyễn Gia Trí, Phường 25, Bình Thạnh, TP.HCM',
    '69/17 Nguyễn Gia Trí, Phường 25, Bình Thạnh, TP.HCM',
    '69/19 Nguyễn Gia Trí, Phường 25, Bình Thạnh, TP.HCM',
    '475 Điện Biên Phủ, Phường 25, Bình Thạnh, TP.HCM',
    '477 Điện Biên Phủ, Phường 25, Bình Thạnh, TP.HCM',
    '479 Điện Biên Phủ, Phường 25, Bình Thạnh, TP.HCM',
    '481 Điện Biên Phủ, Phường 25, Bình Thạnh, TP.HCM',
    '483 Điện Biên Phủ, Phường 25, Bình Thạnh, TP.HCM',
    '485 Điện Biên Phủ, Phường 25, Bình Thạnh, TP.HCM',
    '487 Điện Biên Phủ, Phường 25, Bình Thạnh, TP.HCM',
    '489 Điện Biên Phủ, Phường 25, Bình Thạnh, TP.HCM',
    '491 Điện Biên Phủ, Phường 25, Bình Thạnh, TP.HCM',
    '493 Điện Biên Phủ, Phường 25, Bình Thạnh, TP.HCM',
    '250 Cộng Hòa, Phường 12, Tân Bình, TP.HCM',
    '252 Cộng Hòa, Phường 12, Tân Bình, TP.HCM',
    '254 Cộng Hòa, Phường 12, Tân Bình, TP.HCM',
    '256 Cộng Hòa, Phường 12, Tân Bình, TP.HCM',
    '258 Cộng Hòa, Phường 12, Tân Bình, TP.HCM',
    '260 Cộng Hòa, Phường 12, Tân Bình, TP.HCM',
    '262 Cộng Hòa, Phường 12, Tân Bình, TP.HCM',
    '264 Cộng Hòa, Phường 12, Tân Bình, TP.HCM',
    '266 Cộng Hòa, Phường 12, Tân Bình, TP.HCM',
    '268 Cộng Hòa, Phường 12, Tân Bình, TP.HCM',
    '12 Lê Văn Việt, Hiệp Phú, TP Thủ Đức, TP.HCM',
    '14 Lê Văn Việt, Hiệp Phú, TP Thủ Đức, TP.HCM',
    '16 Lê Văn Việt, Hiệp Phú, TP Thủ Đức, TP.HCM',
    '18 Lê Văn Việt, Hiệp Phú, TP Thủ Đức, TP.HCM',
    '20 Lê Văn Việt, Hiệp Phú, TP Thủ Đức, TP.HCM',
    '22 Lê Văn Việt, Hiệp Phú, TP Thủ Đức, TP.HCM',
    '24 Lê Văn Việt, Hiệp Phú, TP Thủ Đức, TP.HCM',
    '26 Lê Văn Việt, Hiệp Phú, TP Thủ Đức, TP.HCM',
    '28 Lê Văn Việt, Hiệp Phú, TP Thủ Đức, TP.HCM',
    '30 Lê Văn Việt, Hiệp Phú, TP Thủ Đức, TP.HCM',
    '168 Võ Văn Ngân, Linh Chiểu, TP Thủ Đức, TP.HCM',
    '170 Võ Văn Ngân, Linh Chiểu, TP Thủ Đức, TP.HCM',
    '172 Võ Văn Ngân, Linh Chiểu, TP Thủ Đức, TP.HCM',
    '174 Võ Văn Ngân, Linh Chiểu, TP Thủ Đức, TP.HCM',
    '176 Võ Văn Ngân, Linh Chiểu, TP Thủ Đức, TP.HCM',
    '178 Võ Văn Ngân, Linh Chiểu, TP Thủ Đức, TP.HCM',
    '180 Võ Văn Ngân, Linh Chiểu, TP Thủ Đức, TP.HCM',
    '182 Võ Văn Ngân, Linh Chiểu, TP Thủ Đức, TP.HCM',
    '184 Võ Văn Ngân, Linh Chiểu, TP Thủ Đức, TP.HCM',
    '186 Võ Văn Ngân, Linh Chiểu, TP Thủ Đức, TP.HCM',
    '25 Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM',
    '27 Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM',
    '29 Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM',
    '31 Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM',
    '33 Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM',
    '35 Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM',
    '37 Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM',
    '39 Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM',
    '41 Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM',
    '43 Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM',
    '19 Nguyễn Văn Linh, Tân Phú, Quận 7, TP.HCM',
    '21 Nguyễn Văn Linh, Tân Phú, Quận 7, TP.HCM',
    '23 Nguyễn Văn Linh, Tân Phú, Quận 7, TP.HCM',
    '25 Nguyễn Văn Linh, Tân Phú, Quận 7, TP.HCM',
    '27 Nguyễn Văn Linh, Tân Phú, Quận 7, TP.HCM',
    '29 Nguyễn Văn Linh, Tân Phú, Quận 7, TP.HCM',
    '31 Nguyễn Văn Linh, Tân Phú, Quận 7, TP.HCM',
    '33 Nguyễn Văn Linh, Tân Phú, Quận 7, TP.HCM',
    '35 Nguyễn Văn Linh, Tân Phú, Quận 7, TP.HCM',
    '37 Nguyễn Văn Linh, Tân Phú, Quận 7, TP.HCM',
    '32 Đường Số 7, Khu Tên Lửa, Bình Tân, TP.HCM',
    '34 Đường Số 7, Khu Tên Lửa, Bình Tân, TP.HCM',
    '36 Đường Số 7, Khu Tên Lửa, Bình Tân, TP.HCM',
    '38 Đường Số 7, Khu Tên Lửa, Bình Tân, TP.HCM',
    '40 Đường Số 7, Khu Tên Lửa, Bình Tân, TP.HCM',
    '42 Đường Số 7, Khu Tên Lửa, Bình Tân, TP.HCM',
    '44 Đường Số 7, Khu Tên Lửa, Bình Tân, TP.HCM',
    '46 Đường Số 7, Khu Tên Lửa, Bình Tân, TP.HCM',
    '48 Đường Số 7, Khu Tên Lửa, Bình Tân, TP.HCM',
    '50 Đường Số 7, Khu Tên Lửa, Bình Tân, TP.HCM'
  ];  const routes = [
    `${DELIVERY_WAREHOUSE} → 25 Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM → 45 Lê Lợi, Bến Nghé, Quận 1, TP.HCM`,
    `${DELIVERY_WAREHOUSE} → 315 Nguyễn Thái Sơn, Phường 5, Gò Vấp, TP.HCM → 77 Quang Trung, Phường 10, Gò Vấp, TP.HCM`,
    `${DELIVERY_WAREHOUSE} → 12 Lê Văn Việt, Hiệp Phú, TP Thủ Đức, TP.HCM → 168 Võ Văn Ngân, Linh Chiểu, TP Thủ Đức, TP.HCM`,
    `${DELIVERY_WAREHOUSE} → 19 Nguyễn Văn Linh, Tân Phú, Quận 7, TP.HCM → 280 Nguyễn Hữu Thọ, Phước Kiển, Nhà Bè, TP.HCM`,
    `${DELIVERY_WAREHOUSE} → 32 Đường Số 7, Khu Tên Lửa, Bình Tân, TP.HCM → Lô 12 KCN Tân Tạo, Bình Tân, TP.HCM`,
    `${DELIVERY_WAREHOUSE} → KCN Sóng Thần, Dĩ An, Bình Dương → 550 Đại lộ Bình Dương, Thủ Dầu Một, Bình Dương`
  ];
  const statusByIndex = (i) => {
    // Bản demo ưu tiên 100 đơn sẵn sàng giao để bấm Greedy là chia chuyến ngay.
    if (i <= 100) return 'Sẵn sàng giao';
    return 'Sẵn sàng giao';
  };

  const status = statusByIndex(index);
  const driverPool = ['Tài xế Demo'];
  const shouldAssign = false;
  const driver = 'Chưa phân';
  const vehicle = shouldAssign ? (index % 3 === 0 ? 'Xe tải 1 tấn' : index % 3 === 1 ? 'Xe tải nhỏ' : 'Xe máy giao nhanh') : '';
  const selectedA = products[index % products.length];
  const selectedB = products[(index + 3) % products.length];
  const qtyA = (index % 3) + 1;
  const qtyB = index % 4 === 0 ? 2 : 1;
  const items = [
    { ...selectedA, quantity: qtyA, stock: 50 },
    { ...selectedB, quantity: qtyB, stock: 50 }
  ];
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const shipping = index % 5 === 0 ? 45000 : index % 2 === 0 ? 25000 : 30000;
  const discount = index % 10 === 0 ? 50000 : 0;
  const created = new Date(Date.now() - index * 1000 * 60 * 38).toISOString();
  const customer = customers[index % customers.length];
  const address = addresses[index % addresses.length];
  const deliveryMeta = inferDeliveryPoint(address);
  const totalWeightKg = calculateOrderWeightKg(items);

  return {
    orderId: `LGDEMO202607-${pad}`,
    customer,
    userId: customerUserId,
    phone: `09${String(10000000 + index * 7919).slice(-8)}`,
    address,
    email: `khach${pad}@demo.vn`,
    companyName: index % 4 === 0 ? 'Công ty Demo Logistics' : 'Khách lẻ',
    currentLocation: status.includes('cảng') || status.includes('phân') ? 'Cảng Cát Lái' : status.includes('giao') ? address : 'Kho trung tâm LogiPort',
    totalWeightKg,
    deliveryPoint: deliveryMeta.label,
    deliveryZone: deliveryMeta.zone,
    shipmentNo: shouldAssign ? `CHUYEN-${String(Math.ceil(index / 12)).padStart(3, '0')}` : '',
    deliverySequence: shouldAssign ? ((index - 1) % 12) + 1 : 0,
    greedyRoute: shouldAssign ? routes[index % routes.length] : '',
    estimatedKm: shouldAssign ? 12 + (index % 35) : 0,
    staffInCharge: index % 2 === 0 ? 'Lê Nhân Viên' : 'Nguyễn Quản Trị',
    payment: index % 4 === 0 ? 'Chuyển khoản ngân hàng' : 'Thanh toán khi nhận hàng',
    total: subtotal + shipping - discount,
    items: JSON.stringify(items),
    department: index % 2 === 0 ? 'Đơn khách đặt' : 'Kinh doanh online',
    status,
    driver,
    vehicle,
    route: shouldAssign ? routes[index % routes.length] : 'Chờ Admin duyệt và phân công',
    note: status === 'Chờ xác nhận'
      ? 'Đơn demo mới cần Admin/Staff duyệt.'
      : status === 'Đã duyệt'
        ? 'Đơn đã duyệt, chờ kho đóng gói.'
        : status === 'Đang đóng gói'
          ? 'Kho đang chuẩn bị hàng.'
          : status === 'Sẵn sàng giao'
            ? 'Đơn đã sẵn sàng để phân tài xế.'
            : `Đơn demo đã phân cho ${driver}.`,
    createdAt: created,
    updatedAt: created
  };
}

async function seedDemoOrders(targetCount = 100) {
  const countRow = await dbGet('SELECT COUNT(*) AS count FROM orders');
  const currentCount = Number(countRow?.count || 0);
  if (currentCount >= targetCount) return;

  const customerUser = await dbGet('SELECT id FROM users WHERE username = ?', ['khachhang']);
  const missing = targetCount - currentCount;
  const startIndex = currentCount + 1;
  for (let offset = 0; offset < missing; offset += 1) {
    const order = buildDemoOrder(startIndex + offset, customerUser?.id || '');
    await dbRun(
      `INSERT OR IGNORE INTO orders (orderId, customer, userId, phone, address, email, companyName, currentLocation, staffInCharge, payment, total, items, department, status, driver, vehicle, route, note, createdAt, updatedAt, totalWeightKg, deliveryPoint, deliveryZone, shipmentNo, deliverySequence, greedyRoute, estimatedKm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [order.orderId, order.customer, order.userId, order.phone, order.address, order.email, order.companyName, order.currentLocation, order.staffInCharge, order.payment, order.total, order.items, order.department, order.status, order.driver, order.vehicle, order.route, order.note, order.createdAt, order.updatedAt, order.totalWeightKg, order.deliveryPoint, order.deliveryZone, order.shipmentNo, order.deliverySequence, order.greedyRoute, order.estimatedKm]
    );
  }
  console.log(`Seeded ${missing} demo orders. Total demo target: ${targetCount}.`);
}


const defaultProductCatalog = [
  {
    "id": "p-keyboard-leobog",
    "name": "Bàn phím cơ LEOBOG K81 RGB LovKey",
    "price": 1290000,
    "category": "Điện tử",
    "description": "Switch Blue · LED RGB · bảo hành 12 tháng",
    "stock": 18,
    "image": "images/keyboard.png",
    "status": "Đang bán",
    "weightKg": 0.8
  },
  {
    "id": "p-mouse-t1",
    "name": "Chuột gaming không dây T1 TogeTH",
    "price": 690000,
    "category": "Điện tử",
    "description": "Pin lâu · DPI cao · giao nhanh",
    "stock": 26,
    "image": "images/mouse.png",
    "status": "Đang bán",
    "weightKg": 0.2
  },
  {
    "id": "p-laptop-rog",
    "name": "Laptop gaming ASUS ROG Strix RGB",
    "price": 36990000,
    "category": "Điện tử",
    "description": "RTX · RGB · bảo hiểm vận chuyển",
    "stock": 7,
    "image": "images/laptop.png",
    "status": "Đang bán",
    "weightKg": 3.2
  },
  {
    "id": "p-headphone-rgb",
    "name": "Tai nghe gaming RGB có mic chống ồn",
    "price": 890000,
    "category": "Điện tử",
    "description": "Gaming gear · mic rõ · đóng gói chống sốc",
    "stock": 14,
    "image": "images/headphone.png",
    "status": "Đang bán",
    "weightKg": 0.7
  },
  {
    "id": "p-iphone-orange",
    "name": "iPhone 17 Pro màu cam chính hãng",
    "price": 31990000,
    "category": "Điện tử",
    "description": "5G · theo dõi kiện hàng realtime",
    "stock": 9,
    "image": "images/phone.png",
    "status": "Đang bán",
    "weightKg": 0.4
  },
  {
    "id": "p-monitor-24",
    "name": "Màn hình gaming 24 inch 144Hz",
    "price": 3290000,
    "category": "Điện tử",
    "description": "144Hz · bảo hành chính hãng",
    "stock": 12,
    "image": "images/man-hinh-gaming-24-inch.svg",
    "status": "Đang bán",
    "weightKg": 4.2
  },
  {
    "id": "p-speaker-mini",
    "name": "Loa Bluetooth mini chống nước",
    "price": 390000,
    "category": "Điện tử",
    "description": "Chống nước · pin lâu",
    "stock": 20,
    "image": "images/loa-bluetooth-mini.svg",
    "status": "Đang bán",
    "weightKg": 0.6
  },
  {
    "id": "p-ssd-512",
    "name": "SSD 512GB tốc độ cao cho laptop",
    "price": 890000,
    "category": "Điện tử",
    "description": "NVMe · bảo hành 36 tháng",
    "stock": 16,
    "image": "images/ssd-512gb-toc-o-cao.svg",
    "status": "Đang bán",
    "weightKg": 0.1
  },
  {
    "id": "p-webcam-hd",
    "name": "Webcam Full HD học tập livestream",
    "price": 420000,
    "category": "Điện tử",
    "description": "1080p · mic tích hợp",
    "stock": 30,
    "image": "images/laptop.png",
    "status": "Đang bán",
    "weightKg": 0.2
  },
  {
    "id": "p-router-wifi",
    "name": "Router WiFi 6 băng tần kép",
    "price": 1190000,
    "category": "Điện tử",
    "description": "WiFi 6 · phủ sóng mạnh",
    "stock": 22,
    "image": "images/loa-bluetooth-mini.svg",
    "status": "Đang bán",
    "weightKg": 0.8
  },
  {
    "id": "p-powerbank",
    "name": "Pin dự phòng 20000mAh sạc nhanh",
    "price": 590000,
    "category": "Điện tử",
    "description": "Sạc nhanh · phù hợp du lịch",
    "stock": 34,
    "image": "images/phone.png",
    "status": "Đang bán",
    "weightKg": 0.5
  },
  {
    "id": "p-printer-mini",
    "name": "Máy in tem mã vận đơn mini",
    "price": 1650000,
    "category": "Điện tử",
    "description": "In nhãn kho vận · kết nối USB",
    "stock": 11,
    "image": "images/label-printer.jpg",
    "status": "Đang bán",
    "weightKg": 2.4
  },
  {
    "id": "p-tshirt-t1",
    "name": "Áo thun T1 Worlds 2020 oversize",
    "price": 350000,
    "category": "Thời trang",
    "description": "Oversize · cotton dày · hình in sắc nét",
    "stock": 35,
    "image": "images/tshirt.png",
    "status": "Đang bán",
    "weightKg": 0.3
  },
  {
    "id": "p-jeans-cargo",
    "name": "Quần jeans cargo ống rộng streetwear",
    "price": 420000,
    "category": "Thời trang",
    "description": "Form rộng · unisex",
    "stock": 22,
    "image": "images/jeans.png",
    "status": "Đang bán",
    "weightKg": 0.6
  },
  {
    "id": "p-shoes-phantom",
    "name": "Giày Nike Phantom GX sân cỏ nhân tạo",
    "price": 1590000,
    "category": "Thời trang",
    "description": "Đế TF · bám sân tốt",
    "stock": 28,
    "image": "images/shoes.png",
    "status": "Đang bán",
    "weightKg": 0.9
  },
  {
    "id": "p-bag-t1",
    "name": "Túi trống T1 du lịch thể thao",
    "price": 450000,
    "category": "Thời trang",
    "description": "Chống nước nhẹ · nhiều ngăn",
    "stock": 19,
    "image": "images/bag.png",
    "status": "Đang bán",
    "weightKg": 0.8
  },
  {
    "id": "p-backpack-t1",
    "name": "Balo T1 gaming backpack chống nước",
    "price": 690000,
    "category": "Thời trang",
    "description": "Laptop 15.6 inch · chống nước",
    "stock": 11,
    "image": "images/backpack.png",
    "status": "Đang bán",
    "weightKg": 0.9
  },
  {
    "id": "p-jacket-sun",
    "name": "Áo khoác dù chống nắng unisex",
    "price": 239000,
    "category": "Thời trang",
    "description": "Gấp gọn · dễ vận chuyển",
    "stock": 17,
    "image": "images/ao-khoac-du-chong-nang.svg",
    "status": "Đang bán",
    "weightKg": 0.4
  },
  {
    "id": "p-cap-basic",
    "name": "Mũ lưỡi trai basic nhiều màu",
    "price": 89000,
    "category": "Thời trang",
    "description": "Basic · nhiều màu",
    "stock": 24,
    "image": "images/mu-luoi-trai-basic.svg",
    "status": "Đang bán",
    "weightKg": 0.1
  },
  {
    "id": "p-wallet-mini",
    "name": "Ví da nam nữ mini tiện dụng",
    "price": 189000,
    "category": "Thời trang",
    "description": "Gọn nhẹ · chống trầy",
    "stock": 15,
    "image": "images/vi-da-nam-nu-mini.svg",
    "status": "Đang bán",
    "weightKg": 0.2
  },
  {
    "id": "p-socks-sport",
    "name": "Vớ thể thao cổ trung thoáng khí",
    "price": 79000,
    "category": "Thời trang",
    "description": "Combo 3 đôi · thấm hút tốt",
    "stock": 50,
    "image": "images/shoes.png",
    "status": "Đang bán",
    "weightKg": 0.1
  },
  {
    "id": "p-belt-leather",
    "name": "Thắt lưng da nam khóa tự động",
    "price": 220000,
    "category": "Thời trang",
    "description": "Da PU · khóa bền",
    "stock": 33,
    "image": "images/bag.png",
    "status": "Đang bán",
    "weightKg": 0.2
  },
  {
    "id": "p-dress-casual",
    "name": "Đầm nữ casual đi chơi",
    "price": 390000,
    "category": "Thời trang",
    "description": "Form trẻ trung · nhẹ nhàng",
    "stock": 20,
    "image": "images/tshirt.png",
    "status": "Đang bán",
    "weightKg": 0.3
  },
  {
    "id": "p-hoodie-basic",
    "name": "Hoodie basic nỉ bông unisex",
    "price": 360000,
    "category": "Thời trang",
    "description": "Nỉ dày · form rộng",
    "stock": 18,
    "image": "images/ao-khoac-du-chong-nang.svg",
    "status": "Đang bán",
    "weightKg": 0.7
  },
  {
    "id": "p-model-ship",
    "name": "Mô hình tàu container trang trí",
    "price": 459000,
    "category": "Mô hình",
    "description": "Chủ đề cảng biển · hộp trưng bày",
    "stock": 30,
    "image": "images/model-ship-maersk.webp",
    "status": "Đang bán",
    "weightKg": 1.2
  },
  {
    "id": "p-model-truck",
    "name": "Mô hình xe container tỉ lệ 1:32",
    "price": 349000,
    "category": "Mô hình",
    "description": "Đóng hộp chống va đập",
    "stock": 18,
    "image": "images/model-truck-maersk.webp",
    "status": "Đang bán",
    "weightKg": 1.0
  },
  {
    "id": "p-lego-port",
    "name": "Bộ xếp hình cảng biển và xe tải",
    "price": 690000,
    "category": "Mô hình",
    "description": "Quà tặng logistics",
    "stock": 10,
    "image": "images/lego-city-truck.webp",
    "status": "Đang bán",
    "weightKg": 1.4
  },
  {
    "id": "p-mascot",
    "name": "Gấu bông mascot nhân viên giao hàng",
    "price": 189000,
    "category": "Mô hình",
    "description": "Gói quà miễn phí",
    "stock": 13,
    "image": "images/mascot-delivery.jpg",
    "status": "Đang bán",
    "weightKg": 0.4
  },
  {
    "id": "p-ship-bottle",
    "name": "Mô hình tàu biển mini để bàn",
    "price": 259000,
    "category": "Mô hình",
    "description": "Hàng dễ vỡ · đóng gói kỹ",
    "stock": 21,
    "image": "images/ship-in-bottle.jpg",
    "status": "Đang bán",
    "weightKg": 0.6
  },
  {
    "id": "p-plane-model",
    "name": "Mô hình máy bay vận tải kim loại",
    "price": 349000,
    "category": "Mô hình",
    "description": "Hộp trưng bày đi kèm",
    "stock": 16,
    "image": "images/model-truck-maersk.webp",
    "status": "Đang bán",
    "weightKg": 0.5
  },
  {
    "id": "p-forklift-model",
    "name": "Bộ xe nâng mô hình kho vận",
    "price": 259000,
    "category": "Mô hình",
    "description": "Đóng hộp chắc chắn",
    "stock": 25,
    "image": "images/lego-city-truck.webp",
    "status": "Đang bán",
    "weightKg": 0.5
  },
  {
    "id": "p-keychain-container",
    "name": "Móc khóa container mini kim loại",
    "price": 49000,
    "category": "Mô hình",
    "description": "Phù hợp làm quà tặng",
    "stock": 40,
    "image": "images/model-ship-maersk.webp",
    "status": "Đang bán",
    "weightKg": 0.1
  },
  {
    "id": "p-rice-cooker",
    "name": "Nồi cơm điện dung tích 1.8L",
    "price": 690000,
    "category": "Gia dụng",
    "description": "Đóng thùng chống sốc",
    "stock": 32,
    "image": "images/home-appliance-set.jpg",
    "status": "Đang bán",
    "weightKg": 3.5
  },
  {
    "id": "p-fan-stand",
    "name": "Quạt điện đứng điều khiển từ xa",
    "price": 550000,
    "category": "Gia dụng",
    "description": "Hàng cồng kềnh · giao xe tải",
    "stock": 18,
    "image": "images/fan-stand.jpg",
    "status": "Đang bán",
    "weightKg": 5.0
  },
  {
    "id": "p-blender",
    "name": "Máy xay sinh tố đa năng gia đình",
    "price": 430000,
    "category": "Gia dụng",
    "description": "Bảo hiểm vận chuyển",
    "stock": 22,
    "image": "images/blender.jpg",
    "status": "Đang bán",
    "weightKg": 2.8
  },
  {
    "id": "p-chair-office",
    "name": "Ghế văn phòng xoay lưng lưới",
    "price": 890000,
    "category": "Gia dụng",
    "description": "Ghế công thái học · dùng ảnh chair.png",
    "stock": 11,
    "image": "images/chair.PNG",
    "status": "Đang bán",
    "weightKg": 12.0
  },
  {
    "id": "p-folding-sofa",
    "name": "Nệm gấp văn phòng giao tận nơi",
    "price": 1290000,
    "category": "Gia dụng",
    "description": "Tính phí theo quãng đường",
    "stock": 8,
    "image": "images/folding-sofa.jpg",
    "status": "Đang bán",
    "weightKg": 15.0
  },
  {
    "id": "p-kettle",
    "name": "Ấm siêu tốc inox 1.8L tự ngắt",
    "price": 260000,
    "category": "Gia dụng",
    "description": "Đóng hộp chống móp",
    "stock": 27,
    "image": "images/home-appliance-set.jpg",
    "status": "Đang bán",
    "weightKg": 1.5
  },
  {
    "id": "p-led-lamp",
    "name": "Đèn bàn học LED chống mỏi mắt",
    "price": 210000,
    "category": "Gia dụng",
    "description": "3 chế độ sáng · tiết kiệm điện",
    "stock": 16,
    "image": "images/home-appliance-set.jpg",
    "status": "Đang bán",
    "weightKg": 0.8
  },
  {
    "id": "p-shelf-4",
    "name": "Kệ để đồ đa năng 4 tầng",
    "price": 490000,
    "category": "Gia dụng",
    "description": "Hàng cồng kềnh",
    "stock": 20,
    "image": "images/folding-sofa.jpg",
    "status": "Đang bán",
    "weightKg": 7.0
  },
  {
    "id": "p-air-fryer",
    "name": "Nồi chiên không dầu 5L",
    "price": 1590000,
    "category": "Gia dụng",
    "description": "Tiện lợi · dễ vệ sinh",
    "stock": 14,
    "image": "images/home-appliance-set.jpg",
    "status": "Đang bán",
    "weightKg": 5.5
  },
  {
    "id": "p-steam-iron",
    "name": "Bàn ủi hơi nước cầm tay",
    "price": 390000,
    "category": "Gia dụng",
    "description": "Gọn nhẹ · nhanh nóng",
    "stock": 26,
    "image": "images/home-appliance-set.jpg",
    "status": "Đang bán",
    "weightKg": 1.4
  },
  {
    "id": "p-carton",
    "name": "Thùng carton 5 lớp đóng hàng xuất kho",
    "price": 18000,
    "category": "Đóng gói",
    "description": "Combo giảm theo số lượng",
    "stock": 150,
    "image": "images/carton-box.jpg",
    "status": "Đang bán",
    "weightKg": 0.2
  },
  {
    "id": "p-pallet",
    "name": "Pallet gỗ kê hàng trong kho và container",
    "price": 220000,
    "category": "Đóng gói",
    "description": "Mua 10 giảm 5%",
    "stock": 75,
    "image": "images/pallet-wood.webp",
    "status": "Đang bán",
    "weightKg": 9.0
  },
  {
    "id": "p-pe-film",
    "name": "Màng PE quấn kiện hàng chống bụi, chống ẩm",
    "price": 115000,
    "category": "Đóng gói",
    "description": "Combo kho vận",
    "stock": 44,
    "image": "images/pe-film.jpg",
    "status": "Đang bán",
    "weightKg": 2.5
  },
  {
    "id": "p-label",
    "name": "Tem nhãn mã vận đơn cho kiện hàng",
    "price": 65000,
    "category": "Đóng gói",
    "description": "In theo yêu cầu",
    "stock": 260,
    "image": "images/label-printer.jpg",
    "status": "Đang bán",
    "weightKg": 0.3
  },
  {
    "id": "p-strapping",
    "name": "Bộ dụng cụ đóng đai kiện hàng kho vận",
    "price": 420000,
    "category": "Đóng gói",
    "description": "Tặng dây đai",
    "stock": 35,
    "image": "images/strapping-tool.jpg",
    "status": "Đang bán",
    "weightKg": 3.0
  },
  {
    "id": "p-tape",
    "name": "Băng keo đóng thùng siêu dính",
    "price": 75000,
    "category": "Đóng gói",
    "description": "Combo 6 cuộn",
    "stock": 120,
    "image": "images/carton-box.jpg",
    "status": "Đang bán",
    "weightKg": 0.8
  },
  {
    "id": "p-airbag",
    "name": "Túi khí chèn hàng chống va đập",
    "price": 135000,
    "category": "Đóng gói",
    "description": "Bảo vệ hàng dễ vỡ",
    "stock": 90,
    "image": "images/pe-film.jpg",
    "status": "Đang bán",
    "weightKg": 1.2
  },
  {
    "id": "p-cable-tie",
    "name": "Dây rút nhựa cố định hàng hóa",
    "price": 39000,
    "category": "Đóng gói",
    "description": "Gói 100 sợi",
    "stock": 310,
    "image": "images/carton-box.jpg",
    "status": "Đang bán",
    "weightKg": 0.2
  },
  {
    "id": "p-fragile-sticker",
    "name": "Tem cảnh báo hàng dễ vỡ",
    "price": 55000,
    "category": "Đóng gói",
    "description": "Cuộn 500 tem",
    "stock": 200,
    "image": "images/label-printer.jpg",
    "status": "Đang bán",
    "weightKg": 0.2
  },
  {
    "id": "p-foam-roll",
    "name": "Xốp foam cuộn chống sốc",
    "price": 99000,
    "category": "Đóng gói",
    "description": "Gói hàng dễ vỡ",
    "stock": 80,
    "image": "images/pe-film.jpg",
    "status": "Đang bán",
    "weightKg": 1.6
  }

  ,{
    "id": "p-monitor-gaming", "name": "Màn hình gaming 24 inch 165Hz", "price": 3490000, "category": "Điện tử", "description": "IPS · viền mỏng · bảo hành 24 tháng", "stock": 15, "image": "images/monitor-gaming.png", "status": "Đang bán", "weightKg": 4.0
  },{
    "id": "p-smartwatch-s9", "name": "Đồng hồ thông minh S9 Pro", "price": 1290000, "category": "Điện tử", "description": "Theo dõi sức khỏe · pin 7 ngày", "stock": 28, "image": "images/smartwatch.png", "status": "Đang bán", "weightKg": 0.2
  },{
    "id": "p-earbuds-pro", "name": "Tai nghe Bluetooth AirPods Pro 2", "price": 4890000, "category": "Điện tử", "description": "Chống ồn · hộp sạc nhanh", "stock": 21, "image": "images/earbuds-pro.png", "status": "Đang bán", "weightKg": 0.1
  },{
    "id": "p-powerbank-20000", "name": "Sạc dự phòng 20000mAh Fast Charge", "price": 490000, "category": "Điện tử", "description": "Sạc nhanh PD · 2 cổng USB", "stock": 35, "image": "images/powerbank.png", "status": "Đang bán", "weightKg": 0.5
  },{
    "id": "p-webcam-hd", "name": "Webcam HD 1080p học online", "price": 590000, "category": "Điện tử", "description": "Mic kép · gọi video rõ nét", "stock": 19, "image": "images/webcam-hd.png", "status": "Đang bán", "weightKg": 0.3
  },{
    "id": "p-dress-basic", "name": "Đầm nữ basic dáng xòe", "price": 329000, "category": "Thời trang", "description": "Vải mềm · mặc đi học đi chơi", "stock": 24, "image": "images/dress-fashion.png", "status": "Đang bán", "weightKg": 0.4
  },{
    "id": "p-cap-basic", "name": "Nón lưỡi trai basic streetwear", "price": 129000, "category": "Thời trang", "description": "Form cứng · phối đồ dễ", "stock": 42, "image": "images/cap-basic.png", "status": "Đang bán", "weightKg": 0.2
  },{
    "id": "p-wallet-leather", "name": "Ví da mini nam nữ nhiều ngăn", "price": 189000, "category": "Thời trang", "description": "Da mềm · chống trầy", "stock": 30, "image": "images/wallet-leather.png", "status": "Đang bán", "weightKg": 0.2
  },{
    "id": "p-suitcase-24", "name": "Vali du lịch 24 inch chống va đập", "price": 890000, "category": "Thời trang", "description": "Bánh xoay 360° · khóa số", "stock": 12, "image": "images/suitcase.png", "status": "Đang bán", "weightKg": 4.5
  },{
    "id": "p-ergonomic-chair-pro", "name": "Ghế công thái học Pro lưng lưới", "price": 1890000, "category": "Gia dụng", "description": "Nâng hạ · ngả lưng · giao xe tải", "stock": 10, "image": "images/ergonomic-chair.png", "status": "Đang bán", "weightKg": 14.0
  }
  ,{
    "id": "p-ai-macbook-air-m4", "name": "MacBook Air M4 13 inch", "price": 26990000, "category": "Điện tử", "description": "Ảnh AI mới · mỏng nhẹ · phù hợp học thiết kế", "stock": 9, "image": "images/ai-macbook-air-m4.svg", "status": "Đang bán", "weightKg": 1.3
  },{
    "id": "p-ai-ipad-pro-m4", "name": "iPad Pro M4 11 inch 256GB", "price": 28990000, "category": "Điện tử", "description": "Ảnh AI mới · màn OLED · học thiết kế", "stock": 8, "image": "images/ai-ipad-pro-m4.svg", "status": "Đang bán", "weightKg": 0.7
  },{
    "id": "p-ai-apple-pencil-pro", "name": "Apple Pencil Pro chính hãng", "price": 3490000, "category": "Điện tử", "description": "Ảnh AI mới · vẽ minh họa · ghi chú", "stock": 18, "image": "images/ai-apple-pencil-pro.svg", "status": "Đang bán", "weightKg": 0.1
  },{
    "id": "p-ai-logitech-mx-keys", "name": "Logitech MX Keys S Wireless", "price": 2490000, "category": "Điện tử", "description": "Ảnh AI mới · bàn phím văn phòng cao cấp", "stock": 16, "image": "images/ai-logitech-mx-keys.svg", "status": "Đang bán", "weightKg": 0.9
  },{
    "id": "p-ai-mx-master-3s", "name": "Logitech MX Master 3S", "price": 2190000, "category": "Điện tử", "description": "Ảnh AI mới · chuột công thái học", "stock": 20, "image": "images/ai-mx-master-3s.svg", "status": "Đang bán", "weightKg": 0.2
  },{
    "id": "p-ai-sony-xm6", "name": "Sony WH-1000XM6 chống ồn", "price": 8990000, "category": "Điện tử", "description": "Ảnh AI mới · tai nghe chống ồn cao cấp", "stock": 10, "image": "images/ai-sony-xm6.svg", "status": "Đang bán", "weightKg": 0.4
  },{
    "id": "p-ai-odyssey-g6", "name": "Samsung Odyssey G6 27 inch", "price": 9490000, "category": "Điện tử", "description": "Ảnh AI mới · màn cong gaming", "stock": 7, "image": "images/ai-samsung-odyssey-g6.svg", "status": "Đang bán", "weightKg": 6.5
  },{
    "id": "p-ai-router-wifi7", "name": "Router WiFi 7 tốc độ cao", "price": 3290000, "category": "Điện tử", "description": "Ảnh AI mới · phủ sóng mạnh cho văn phòng", "stock": 13, "image": "images/ai-wifi7-router.svg", "status": "Đang bán", "weightKg": 1.0
  },{
    "id": "p-ai-ssd-990-pro", "name": "SSD Samsung 990 Pro 1TB", "price": 2690000, "category": "Điện tử", "description": "Ảnh AI mới · NVMe tốc độ cao", "stock": 22, "image": "images/ai-samsung-990-pro.svg", "status": "Đang bán", "weightKg": 0.1
  },{
    "id": "p-ai-mini-pc", "name": "Mini PC văn phòng NUC", "price": 6990000, "category": "Điện tử", "description": "Ảnh AI mới · nhỏ gọn · tiết kiệm điện", "stock": 11, "image": "images/ai-mini-pc.svg", "status": "Đang bán", "weightKg": 1.2
  },{
    "id": "p-ai-brother-printer", "name": "Máy in Brother Laser văn phòng", "price": 3290000, "category": "Điện tử", "description": "Ảnh AI mới · in nhanh · bền bỉ", "stock": 9, "image": "images/ai-brother-printer.svg", "status": "Đang bán", "weightKg": 7.0
  },{
    "id": "p-ai-barcode-scanner", "name": "Máy quét mã vạch kho hàng", "price": 1290000, "category": "Đóng gói", "description": "Ảnh AI mới · dùng cho kiểm kho", "stock": 25, "image": "images/ai-barcode-scanner.svg", "status": "Đang bán", "weightKg": 0.4
  },{
    "id": "p-ai-thermal-printer", "name": "Máy in nhiệt mã vận đơn", "price": 1590000, "category": "Đóng gói", "description": "Ảnh AI mới · in đơn nhanh cho shop", "stock": 17, "image": "images/ai-thermal-printer.svg", "status": "Đang bán", "weightKg": 1.5
  },{
    "id": "p-ai-agv-robot", "name": "Robot AGV Logistics mini", "price": 18990000, "category": "Mô hình", "description": "Ảnh AI mới · mô phỏng robot kho thông minh", "stock": 5, "image": "images/ai-agv-robot.svg", "status": "Đang bán", "weightKg": 8.0
  },{
    "id": "p-ai-foldable-cart", "name": "Xe đẩy gấp kho vận 150kg", "price": 890000, "category": "Đóng gói", "description": "Ảnh AI mới · hỗ trợ giao nhận hàng nặng", "stock": 14, "image": "images/ai-foldable-cart.svg", "status": "Đang bán", "weightKg": 6.0
  },{
    "id": "p-ai-smart-camera", "name": "Camera AI giám sát kho hàng", "price": 2190000, "category": "Điện tử", "description": "Ảnh AI mới · nhận diện chuyển động", "stock": 19, "image": "images/ai-smart-camera.svg", "status": "Đang bán", "weightKg": 0.8
  },{
    "id": "p-ai-standing-desk", "name": "Bàn nâng hạ thông minh", "price": 4590000, "category": "Gia dụng", "description": "Ảnh AI mới · setup làm việc hiện đại", "stock": 6, "image": "images/ai-standing-desk.svg", "status": "Đang bán", "weightKg": 22.0
  },{
    "id": "p-ai-office-lamp", "name": "Đèn bàn LED Architect", "price": 590000, "category": "Gia dụng", "description": "Ảnh AI mới · chống mỏi mắt", "stock": 24, "image": "images/ai-office-lamp.svg", "status": "Đang bán", "weightKg": 1.1
  },{
    "id": "p-ai-vacuum-robot", "name": "Robot hút bụi AI tự sạc", "price": 5990000, "category": "Gia dụng", "description": "Ảnh AI mới · lau hút thông minh", "stock": 8, "image": "images/ai-vacuum-robot.svg", "status": "Đang bán", "weightKg": 4.0
  },{
    "id": "p-ai-anti-shock-box", "name": "Hộp chống sốc cao cấp", "price": 129000, "category": "Đóng gói", "description": "Ảnh AI mới · bảo vệ hàng dễ vỡ", "stock": 90, "image": "images/ai-anti-shock-box.svg", "status": "Đang bán", "weightKg": 0.5
  }

];

function normalizeDemoProductName(name = '', category = '') {
  const original = String(name || '').trim();
  const text = `${normalizeProductKeyword(name)} ${normalizeProductKeyword(category)}`;
  // Chỉ đổi tên các sản phẩm nhập đại/lỗi rõ ràng, còn sản phẩm bình thường giữ nguyên tên người dùng nhập.
  if (/(vo dich|t1)/.test(text) && /(ao|shirt|thun|fashion|thoi trang)/.test(text)) return 'Áo thun T1 Worlds 2020 oversize';
  if (/^ao vo dich t1$/i.test(normalizeProductKeyword(original))) return 'Áo thun T1 Worlds 2020 oversize';
  return original || 'Sản phẩm mới';
}

async function seedDefaultProducts() {
  // Bản hoàn thiện: mặc định KHÔNG reset sản phẩm khi server khởi động để sản phẩm/ảnh mới không bị mất.
  // Nếu giáo viên muốn làm sạch kho demo, đặt RESET_PRODUCTS_ON_START=true trong file .env rồi chạy lại server.
  const resetProductsOnStart = process.env.RESET_PRODUCTS_ON_START === 'true';
  if (resetProductsOnStart) {
    await dbRun('DELETE FROM products');
    console.log('Reset demo product catalog to clean default list.');
  }

  const now = new Date().toISOString();
  for (const item of defaultProductCatalog) {
    const image = isValidImageSource(item.image) ? item.image : defaultProductImageByNameOrCategory(item.name, item.category);
    await dbRun(
      `INSERT INTO products (id, name, price, category, description, stock, image, status, createdAt, weightKg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         price = excluded.price,
         category = excluded.category,
         description = excluded.description,
         stock = excluded.stock,
         image = excluded.image,
         status = excluded.status,
         weightKg = excluded.weightKg`,
      [item.id, item.name, item.price, item.category, item.description, item.stock, image, item.status, now, item.weightKg || 0.5]
    );
  }
}

async function repairExistingProductCatalog() {
  const rows = await dbAll('SELECT * FROM products');
  for (const product of rows) {
    const fixedName = normalizeDemoProductName(product.name, product.category);
    const fixedImage = defaultProductImageByNameOrCategory(fixedName, product.category);
    const fixedCategory = product.category || (/ao|quan|giay|tui|balo/i.test(normalizeProductKeyword(fixedName)) ? 'Thời trang' : 'Điện tử');
    const fixedDescription = product.description || 'Sản phẩm được chuẩn hóa ảnh và thông tin kho tự động.';
    const fixedStock = Math.max(0, Math.round(Number(product.stock ?? 20)));
    const fixedImageToUse = isValidImageSource(product.image) ? product.image : fixedImage;
    if (product.name !== fixedName || product.image !== fixedImageToUse || !isValidImageSource(product.image)) {
      await dbRun(
        'UPDATE products SET name = ?, category = ?, description = ?, stock = ?, image = ?, status = ? WHERE id = ?',
        [fixedName, fixedCategory, fixedDescription, fixedStock, fixedImageToUse, product.status || 'Đang bán', product.id]
      );
    }
  }
}

async function initDatabase() {
  await dbRun(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    passwordHash TEXT,
    role TEXT,
    displayName TEXT,
    email TEXT,
    phone TEXT,
    address TEXT,
    companyName TEXT,
    taxCode TEXT,
    customerCode TEXT,
    note TEXT,
    updatedAt TEXT
  )`);

  for (const sql of [
    `ALTER TABLE users ADD COLUMN email TEXT`,
    `ALTER TABLE users ADD COLUMN phone TEXT`,
    `ALTER TABLE users ADD COLUMN address TEXT`,
    `ALTER TABLE users ADD COLUMN companyName TEXT`,
    `ALTER TABLE users ADD COLUMN taxCode TEXT`,
    `ALTER TABLE users ADD COLUMN customerCode TEXT`,
    `ALTER TABLE users ADD COLUMN note TEXT`,
    `ALTER TABLE users ADD COLUMN updatedAt TEXT`
  ]) {
    try { await dbRun(sql); } catch (error) { if (!String(error.message).includes('duplicate column')) console.warn(error.message); }
  }

  await dbRun(`CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    category TEXT,
    description TEXT,
    stock INTEGER DEFAULT 20,
    image TEXT,
    status TEXT DEFAULT 'Đang bán',
    createdAt TEXT
  )`);

  for (const sql of [
    `ALTER TABLE products ADD COLUMN stock INTEGER DEFAULT 20`,
    `ALTER TABLE products ADD COLUMN image TEXT`,
    `ALTER TABLE products ADD COLUMN status TEXT DEFAULT 'Đang bán'`,
    `ALTER TABLE products ADD COLUMN weightKg REAL DEFAULT 0.5`
  ]) {
    try { await dbRun(sql); } catch (error) { if (!String(error.message).includes('duplicate column')) console.warn(error.message); }
  }

  await dbRun(`CREATE TABLE IF NOT EXISTS delivery_assignments (
    orderId TEXT PRIMARY KEY,
    driver TEXT NOT NULL,
    vehicle TEXT,
    route TEXT,
    status TEXT,
    assignedAt TEXT
  )`);


  await dbRun(`CREATE TABLE IF NOT EXISTS orders (
    orderId TEXT PRIMARY KEY,
    customer TEXT,
    userId TEXT,
    phone TEXT,
    address TEXT,
    email TEXT,
    companyName TEXT,
    currentLocation TEXT,
    staffInCharge TEXT,
    payment TEXT,
    total INTEGER,
    items TEXT,
    department TEXT,
    status TEXT,
    driver TEXT,
    vehicle TEXT,
    route TEXT,
    note TEXT,
    createdAt TEXT,
    updatedAt TEXT
  )`);


  for (const sql of [
    `ALTER TABLE orders ADD COLUMN companyName TEXT`,
    `ALTER TABLE orders ADD COLUMN currentLocation TEXT`,
    `ALTER TABLE orders ADD COLUMN staffInCharge TEXT`,
    `ALTER TABLE orders ADD COLUMN totalWeightKg REAL`,
    `ALTER TABLE orders ADD COLUMN deliveryPoint TEXT`,
    `ALTER TABLE orders ADD COLUMN deliveryZone TEXT`,
    `ALTER TABLE orders ADD COLUMN shipmentNo TEXT`,
    `ALTER TABLE orders ADD COLUMN deliverySequence INTEGER DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN greedyRoute TEXT`,
    `ALTER TABLE orders ADD COLUMN estimatedKm REAL DEFAULT 0`
  ]) {
    try { await dbRun(sql); } catch (error) { if (!String(error.message).includes('duplicate column')) console.warn(error.message); }
  }

  const defaults = [
    { username: 'admin', password: 'admin123', role: 'admin', displayName: 'Nguyễn Quản Trị', email: 'admin@logiportmart.vn', phone: '0909000001', address: 'Văn phòng điều hành LogiPort', companyName: 'LogiPort Mart', taxCode: '0319998888', customerCode: 'USR-ADMIN' },
    { username: 'nhanvien', password: 'nv123456', role: 'staff', displayName: 'Lê Nhân Viên', email: 'staff@logiportmart.vn', phone: '0909000002', address: 'Kho trung tâm LogiPort', companyName: 'LogiPort Mart', taxCode: '0319998888', customerCode: 'USR-STAFF' },
    { username: 'taixe', password: 'tx123456', role: 'driver', displayName: 'Tài xế Demo', email: 'taixe@logiportmart.vn', phone: '0909000003', address: 'Đội xe LogiPort', companyName: 'LogiPort Mart', taxCode: '0319998888', customerCode: 'USR-DRIVER' },
    { username: 'khachhang', password: 'kh123456', role: 'customer', displayName: 'Trần Khách Hàng', email: 'khachhang@gmail.com', phone: '0364301437', address: '69/1 Nguyễn Gia Trí, Bình Thạnh, TP.HCM', companyName: 'Khách lẻ', taxCode: '', customerCode: 'CUS-0001' }
  ];

  for (const item of defaults) {
    const existingUser = await dbGet('SELECT id, role, displayName FROM users WHERE username = ?', [item.username]);
    const passwordHash = bcrypt.hashSync(item.password, 10);
    if (!existingUser) {
      await dbRun(
        'INSERT INTO users (id, username, passwordHash, role, displayName, email, phone, address, companyName, taxCode, customerCode, note, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`${Date.now()}-${Math.random()}`, item.username, passwordHash, item.role, item.displayName, item.email || '', item.phone || '', item.address || '', item.companyName || '', item.taxCode || '', item.customerCode || '', 'Tài khoản demo hệ thống', new Date().toISOString()]
      );
      console.log(`Created default user ${item.username}`);
    } else {
      // Khóa lại 4 tài khoản demo đúng vai trò để tránh test nhầm: khachhang không thể bị lưu thành admin.
      await dbRun(
        `UPDATE users SET passwordHash = ?, role = ?, displayName = ?, email = COALESCE(NULLIF(email,''), ?), phone = COALESCE(NULLIF(phone,''), ?), address = COALESCE(NULLIF(address,''), ?), companyName = COALESCE(NULLIF(companyName,''), ?), taxCode = COALESCE(NULLIF(taxCode,''), ?), customerCode = COALESCE(NULLIF(customerCode,''), ?), updatedAt = ? WHERE username = ?`,
        [passwordHash, item.role, item.displayName, item.email || '', item.phone || '', item.address || '', item.companyName || '', item.taxCode || '', item.customerCode || '', new Date().toISOString(), item.username]
      );
    }
  }

  await seedDefaultProducts();
  await repairExistingProductCatalog();
  // Database sạch cho buổi demo: không tự sinh đơn mẫu khi khởi động.
  // Khi cần demo, hãy tạo đơn mới từ tài khoản khách hàng rồi duyệt/phân tuyến thật.
  await dbRun("DELETE FROM users WHERE username IN ('taixe_bac','taixe_dong','taixe_nam','taixe_tay','taixe_trungtam')");
}


app.post('/api/register', async (req, res) => {
  const { displayName, username, password } = req.body;
  if (!displayName || !username || !password) {
    return res.status(400).json({ message: 'Vui lòng cung cấp đầy đủ họ tên, username và password.' });
  }

  const existingUser = await dbGet('SELECT id FROM users WHERE username = ?', [username]);
  if (existingUser) {
    return res.status(409).json({ message: 'Username đã tồn tại. Vui lòng chọn username khác.' });
  }

  const newUser = {
    id: `${Date.now()}-${Math.random()}`,
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    role: 'customer',
    displayName,
    email: '',
    phone: '',
    address: '',
    companyName: '',
    taxCode: '',
    customerCode: `CUS-${Date.now().toString().slice(-6)}`,
    note: 'Khách hàng đăng ký từ website',
    updatedAt: new Date().toISOString()
  };

  await dbRun(
    'INSERT INTO users (id, username, passwordHash, role, displayName, email, phone, address, companyName, taxCode, customerCode, note, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [newUser.id, newUser.username, newUser.passwordHash, newUser.role, newUser.displayName, newUser.email, newUser.phone, newUser.address, newUser.companyName, newUser.taxCode, newUser.customerCode, newUser.note, newUser.updatedAt]
  );

  const token = jwt.sign(
    { id: newUser.id, username: newUser.username, role: newUser.role, displayName: newUser.displayName },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.status(201).json({ token, user: publicUser(newUser) });
});

app.get('/api/profile', authenticateToken, async (req, res) => {
  const user = await dbGet('SELECT id, username, role, displayName, email, phone, address, companyName, taxCode, customerCode, note, updatedAt FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ message: 'Không tìm thấy người dùng.' });
  res.json(publicUser(user));
});

app.patch('/api/profile', authenticateToken, async (req, res) => {
  const { displayName, email, phone, address, companyName, taxCode, note } = req.body || {};
  const current = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!current) return res.status(404).json({ message: 'Không tìm thấy người dùng.' });
  const next = {
    displayName: String(displayName || current.displayName || current.username || '').trim(),
    email: String(email || '').trim(),
    phone: String(phone || '').trim(),
    address: String(address || '').trim(),
    companyName: String(companyName || '').trim(),
    taxCode: String(taxCode || '').trim(),
    note: String(note || '').trim(),
    updatedAt: new Date().toISOString()
  };
  await dbRun(
    'UPDATE users SET displayName = ?, email = ?, phone = ?, address = ?, companyName = ?, taxCode = ?, note = ?, updatedAt = ? WHERE id = ?',
    [next.displayName, next.email, next.phone, next.address, next.companyName, next.taxCode, next.note, next.updatedAt, req.user.id]
  );
  const updated = await dbGet('SELECT id, username, role, displayName, email, phone, address, companyName, taxCode, customerCode, note, updatedAt FROM users WHERE id = ?', [req.user.id]);
  res.json({ message: 'Đã lưu hồ sơ khách hàng.', user: publicUser(updated) });
});

app.get('/api/customers', authenticateToken, authorizeRole(['admin', 'staff']), async (req, res) => {
  const customers = await dbAll(`
    SELECT id, username, role, displayName, email, phone, address, companyName, taxCode, customerCode, note, updatedAt
    FROM users
    ORDER BY CASE role WHEN 'customer' THEN 0 WHEN 'driver' THEN 1 WHEN 'staff' THEN 2 ELSE 3 END, displayName COLLATE NOCASE
  `);
  res.json({ customers: customers.map(publicUser) });
});

app.get('/api/customers/export-txt', authenticateToken, authorizeRole(['admin', 'staff']), async (req, res) => {
  const customers = await dbAll(`
    SELECT id, username, role, displayName, email, phone, address, companyName, taxCode, customerCode, note, updatedAt
    FROM users
    ORDER BY role, displayName COLLATE NOCASE
  `);
  const header = 'Mã KH | Họ tên | Username | Vai trò | Email | Số điện thoại | Công ty | MST | Địa chỉ | Ghi chú | Cập nhật';
  const content = [header, ...customers.map(customerTxtLine)].join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="logiport-khach-hang.txt"');
  res.send(content);
});

app.post('/api/reset-demo-products', authenticateToken, authorizeRole(['admin', 'staff']), async (req, res) => {
  await dbRun('DELETE FROM products');
  await seedDefaultProducts();
  await repairExistingProductCatalog();
  const products = await dbAll('SELECT * FROM products ORDER BY createdAt DESC');
  res.json({ message: 'Đã reset lại danh sách sản phẩm mẫu chuẩn.', products });
});

app.get('/api/public-products', async (req, res) => {
  const products = await dbAll('SELECT * FROM products ORDER BY createdAt DESC');
  res.json({ products });
});

app.get('/api/products', authenticateToken, async (req, res) => {
  if (!rolePermissions[req.user.role].includes('view_products')) {
    return res.status(403).json({ message: 'Bạn không có quyền xem sản phẩm.' });
  }

  const products = await dbAll('SELECT * FROM products ORDER BY createdAt DESC');
  res.json({ products });
});

app.post('/api/products', authenticateToken, authorizeRole(['admin', 'staff']), async (req, res) => {
  const { name, price, category, description, stock = 20, image = '', status = 'Đang bán' } = req.body;
  const numericPrice = Number(price);
  const numericStock = Math.max(0, Math.round(Number(stock || 0)));
  if (!name || !numericPrice || numericPrice < 0) {
    return res.status(400).json({ message: 'Thiếu tên sản phẩm hoặc giá bán không hợp lệ.' });
  }

  const product = {
    id: `PRD-${Date.now()}`,
    name: name.trim(),
    price: Math.round(numericPrice),
    category: category || 'Khác',
    description: description || '',
    stock: numericStock,
    image: isValidImageSource(image) ? image : defaultProductImageByNameOrCategory(name, category),
    status,
    createdAt: new Date().toISOString()
  };

  await dbRun(
    'INSERT INTO products (id, name, price, category, description, stock, image, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [product.id, product.name, product.price, product.category, product.description, product.stock, product.image, product.status, product.createdAt]
  );

  res.status(201).json({ message: 'Sản phẩm đã được lưu vào kho.', product });
});

app.put('/api/products/:id', authenticateToken, authorizeRole(['admin', 'staff']), async (req, res) => {
  const { name, price, category, description, stock = 20, image = '', status = 'Đang bán' } = req.body;
  const numericPrice = Number(price);
  const numericStock = Math.max(0, Math.round(Number(stock || 0)));
  if (!name || !numericPrice || numericPrice < 0) {
    return res.status(400).json({ message: 'Thiếu tên sản phẩm hoặc giá bán không hợp lệ.' });
  }

  const existing = await dbGet('SELECT id FROM products WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ message: 'Không tìm thấy sản phẩm.' });

  const product = {
    id: req.params.id,
    name: name.trim(),
    price: Math.round(numericPrice),
    category: category || 'Khác',
    description: description || '',
    stock: numericStock,
    image: isValidImageSource(image) ? image : defaultProductImageByNameOrCategory(name, category),
    status
  };

  await dbRun(
    'UPDATE products SET name = ?, price = ?, category = ?, description = ?, stock = ?, image = ?, status = ? WHERE id = ?',
    [product.name, product.price, product.category, product.description, product.stock, product.image, product.status, product.id]
  );

  res.json({ message: 'Sản phẩm đã được cập nhật.', product });
});

app.delete('/api/products/:id', authenticateToken, authorizeRole(['admin', 'staff']), async (req, res) => {
  const result = await dbRun('DELETE FROM products WHERE id = ?', [req.params.id]);
  if (!result.changes) return res.status(404).json({ message: 'Không tìm thấy sản phẩm.' });
  res.json({ message: 'Sản phẩm đã được xóa.' });
});


function normalizeOrderRow(row = {}) {
  let items = [];
  try { items = row.items ? JSON.parse(row.items) : []; } catch { items = []; }
  return {
    orderId: row.orderId,
    code: row.orderId,
    customer: row.customer || 'Khách hàng',
    userId: row.userId || '',
    phone: row.phone || '',
    address: row.address || '',
    email: row.email || '',
    companyName: row.companyName || '',
    currentLocation: row.currentLocation || row.route || 'Chưa cập nhật',
    staffInCharge: row.staffInCharge || 'Lê Nhân Viên',
    payment: row.payment || '',
    total: Number(row.total || 0),
    items,
    department: row.department || 'Đơn khách đặt',
    status: row.status || 'Chờ xác nhận',
    driver: row.driver || 'Chưa phân',
    vehicle: row.vehicle || '',
    route: row.route || 'Chưa xác định',
    note: row.note || '',
    createdAt: row.createdAt || '',
    placedAt: row.createdAt ? new Date(row.createdAt).toLocaleString('vi-VN') : '',
    updatedAt: row.updatedAt || '',
    weightKg: Number(row.totalWeightKg || calculateOrderWeightKg(items)),
    deliveryPoint: preferSpecificDeliveryPoint(row.deliveryPoint, inferDeliveryPoint(row.address || row.route || '')),
    deliveryZone: row.deliveryZone || inferDeliveryPoint(row.address || row.route || '').zone,
    shipmentNo: row.shipmentNo || '',
    deliverySequence: Number(row.deliverySequence || 0),
    greedyRoute: row.greedyRoute || row.route || '',
    estimatedKm: Number(row.estimatedKm || 0)
  };
}

app.post('/api/orders', authenticateToken, async (req, res) => {
  const { orderId, customer, phone, address, email, companyName, payment, total, items = [], route } = req.body;
  if (!orderId || !customer || !phone || !address) {
    return res.status(400).json({ message: 'Thiếu thông tin đơn hàng.' });
  }

  const now = new Date().toISOString();
  const safeItems = Array.isArray(items) ? items : [];
  const deliveryMeta = inferDeliveryPoint(address);
  const totalWeightKg = calculateOrderWeightKg(safeItems);
  const order = {
    orderId: String(orderId).trim(),
    customer: String(customer).trim(),
    userId: req.user.id,
    phone: String(phone).trim(),
    address: String(address).trim(),
    email: email || '',
    companyName: companyName || '',
    currentLocation: 'Kho trung tâm LogiPort',
    staffInCharge: 'Lê Nhân Viên',
    payment: payment || 'Thanh toán khi nhận hàng',
    total: Math.round(Number(total || 0)),
    items: JSON.stringify(safeItems),
    department: 'Đơn khách đặt',
    status: 'Chờ xác nhận',
    driver: 'Chưa phân',
    vehicle: '',
    route: route || 'Chưa xác định',
    totalWeightKg,
    deliveryPoint: deliveryMeta.label,
    deliveryZone: deliveryMeta.zone,
    shipmentNo: '',
    deliverySequence: 0,
    greedyRoute: '',
    estimatedKm: 0,
    note: 'Đơn hàng mới vừa được đặt.',
    createdAt: now,
    updatedAt: now
  };

  await dbRun(
    `INSERT INTO orders (orderId, customer, userId, phone, address, email, companyName, currentLocation, staffInCharge, payment, total, items, department, status, driver, vehicle, route, note, createdAt, updatedAt, totalWeightKg, deliveryPoint, deliveryZone, shipmentNo, deliverySequence, greedyRoute, estimatedKm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(orderId) DO UPDATE SET
       customer = excluded.customer,
       phone = excluded.phone,
       address = excluded.address,
       email = excluded.email,
       companyName = excluded.companyName,
       currentLocation = excluded.currentLocation,
       staffInCharge = excluded.staffInCharge,
       payment = excluded.payment,
       total = excluded.total,
       items = excluded.items,
       totalWeightKg = excluded.totalWeightKg,
       deliveryPoint = excluded.deliveryPoint,
       deliveryZone = excluded.deliveryZone,
       updatedAt = excluded.updatedAt`,
    [order.orderId, order.customer, order.userId, order.phone, order.address, order.email, order.companyName, order.currentLocation, order.staffInCharge, order.payment, order.total, order.items, order.department, order.status, order.driver, order.vehicle, order.route, order.note, order.createdAt, order.updatedAt, order.totalWeightKg, order.deliveryPoint, order.deliveryZone, order.shipmentNo, order.deliverySequence, order.greedyRoute, order.estimatedKm]
  );

  res.status(201).json({ message: 'Đặt hàng thành công. Admin/Staff đã nhận thông báo đơn mới để duyệt.', order: normalizeOrderRow(order), notifyAdmin: true });
});

app.get('/api/orders', authenticateToken, async (req, res) => {
  if (req.user.role === 'admin' || req.user.role === 'staff') {
    const rows = await dbAll('SELECT * FROM orders ORDER BY createdAt DESC');
    return res.json({ orders: rows.map(normalizeOrderRow) });
  }
  if (req.user.role === 'driver') {
    // Tài xế chỉ thấy đơn ĐANG xử lý. Đơn hoàn tất được chuyển qua /api/driver/completed-orders để không bị lộn.
    const names = Array.from(new Set([req.user.displayName, req.user.username, 'Tài xế Demo'].filter(Boolean)));
    const placeholders = names.map(() => '?').join(',');
    const isDemoDriver = req.user.username === 'taixe' || String(req.user.displayName || '').toLowerCase().includes('tài xế');
    const demoClause = isDemoDriver ? ` OR driver LIKE 'Tài xế%'` : '';
    const rows = await dbAll(
      `SELECT * FROM orders
       WHERE (driver IN (${placeholders})${demoClause})
         AND status IN ('Đã phân công','Tài xế đã nhận','Đang trên đường đến','Đang vận chuyển','Đang giao')
         AND status NOT IN ('Hủy đơn','Từ chối','Đã giao hàng','Hoàn tất')
       ORDER BY deliverySequence ASC, createdAt DESC`,
      names
    );
    return res.json({ orders: rows.map(normalizeOrderRow) });
  }
  const rows = await dbAll('SELECT * FROM orders WHERE userId = ? ORDER BY createdAt DESC', [req.user.id]);
  res.json({ orders: rows.map(normalizeOrderRow) });
});

app.get('/api/driver/completed-orders', authenticateToken, authorizeRole(['driver']), async (req, res) => {
  const names = Array.from(new Set([req.user.displayName, req.user.username, 'Tài xế Demo'].filter(Boolean)));
  const placeholders = names.map(() => '?').join(',');
  const isDemoDriver = req.user.username === 'taixe' || String(req.user.displayName || '').toLowerCase().includes('tài xế');
  const demoClause = isDemoDriver ? ` OR driver LIKE 'Tài xế%'` : '';
  const rows = await dbAll(
    `SELECT * FROM orders
     WHERE (driver IN (${placeholders})${demoClause})
       AND status IN ('Đã giao hàng','Hoàn tất')
     ORDER BY updatedAt DESC, createdAt DESC
     LIMIT 80`,
    names
  );
  res.json({ orders: rows.map(normalizeOrderRow) });
});

app.get('/api/admin/orders', authenticateToken, authorizeRole(['admin', 'staff']), async (req, res) => {
  const rows = await dbAll('SELECT * FROM orders ORDER BY createdAt DESC');
  res.json({ orders: rows.map(normalizeOrderRow) });
});

app.get('/api/admin/notifications', authenticateToken, authorizeRole(['admin', 'staff']), async (req, res) => {
  const rows = await dbAll('SELECT * FROM orders ORDER BY createdAt DESC LIMIT 80');
  const orders = rows.map(normalizeOrderRow);
  const pendingStatuses = ['Chờ xác nhận', 'Đã tiếp nhận', 'Đơn mới', 'Đang xử lý'];
  const pending = orders.filter(order => pendingStatuses.some(st => String(order.status || '').includes(st)));
  const latest = orders.slice(0, 10);
  res.json({
    count: pending.length,
    pending,
    latest,
    message: pending.length ? `Có ${pending.length} đơn mới/chờ duyệt.` : 'Không có đơn chờ duyệt.'
  });
});

app.post('/api/assign', authenticateToken, authorizeRole(['admin', 'staff']), async (req, res) => {
  const { orderId, vehicle, route } = req.body;
  const driver = 'Tài xế Demo';
  if (!orderId) return res.status(400).json({ message: 'Thiếu mã đơn hàng.' });

  const assignment = {
    orderId: orderId.trim(),
    driver,
    vehicle: vehicle || '',
    route: route || 'Chưa cập nhật',
    status: 'Đã phân công',
    assignedAt: new Date().toISOString()
  };

  await dbRun(
    `INSERT INTO delivery_assignments (orderId, driver, vehicle, route, status, assignedAt)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(orderId) DO UPDATE SET
       driver = excluded.driver,
       vehicle = excluded.vehicle,
       route = excluded.route,
       status = excluded.status,
       assignedAt = excluded.assignedAt`,
    [assignment.orderId, assignment.driver, assignment.vehicle, assignment.route, assignment.status, assignment.assignedAt]
  );

  const existingOrder = await dbGet('SELECT orderId, status FROM orders WHERE orderId = ?', [assignment.orderId]);
  if (existingOrder) {
    const currentStatus = String(existingOrder.status || 'Chờ xác nhận');
    const canAssign = ['Đã duyệt', 'Đang đóng gói', 'Sẵn sàng giao', 'Đã phân công'].some(status => currentStatus.includes(status));
    if (!canAssign) {
      return res.status(400).json({ message: `Đơn ${assignment.orderId} đang ở trạng thái "${currentStatus}". Admin/Staff phải duyệt đơn trước rồi mới phân tài xế.` });
    }
    await dbRun(
      `UPDATE orders SET driver = ?, vehicle = ?, route = ?, status = ?, note = ?, updatedAt = ? WHERE orderId = ?`,
      [assignment.driver, assignment.vehicle, assignment.route, assignment.status, `Đơn hàng đã được phân công cho ${assignment.driver}. Chờ tài xế nhận đơn.`, assignment.assignedAt, assignment.orderId]
    );
  }

  res.json({ message: `Đã phân công ${driver} cho đơn ${assignment.orderId}.`, assignment });
});


app.get('/api/logistics/shopee-plan', authenticateToken, authorizeRole(['admin', 'staff', 'driver']), async (req, res) => {
  let rows;
  if (req.user.role === 'driver') {
    // Greedy của tài xế phải lấy từ tổng các đơn đã phân cho tài xế đó,
    // không lấy tất cả đơn hệ thống và không nhập địa chỉ thủ công.
    const names = Array.from(new Set([req.user.displayName, req.user.username, 'Tài xế Demo'].filter(Boolean)));
    const placeholders = names.map(() => '?').join(',');
    rows = await dbAll(
      `SELECT * FROM orders
       WHERE driver IN (${placeholders})
         AND status NOT IN ('Hủy đơn','Từ chối','Đã giao hàng','Hoàn tất')
       ORDER BY shipmentNo ASC, deliverySequence ASC, createdAt DESC
       LIMIT 150`,
      names
    );
  } else {
    rows = await dbAll('SELECT * FROM orders ORDER BY createdAt DESC');
  }
  const plan = buildShopeeMiniPlanFromRows(rows);
  res.json(plan);
});

app.post('/api/logistics/auto-dispatch', authenticateToken, authorizeRole(['admin', 'staff']), async (req, res) => {
  const result = await runAutoWarehouseAndDispatch({ actor: req.user.displayName || req.user.username });
  res.json({ message: `Kho + Điều phối tự động đã xử lý ${result.assigned} đơn: đóng gói, chia chuyến 100kg, gán Tài xế Demo và tạo tuyến Greedy.`, updated: result.assigned, plan: result.plan });
});

app.get('/api/users', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  const usersList = await dbAll('SELECT id, username, role, displayName FROM users');
  res.json({ users: usersList });
});

app.post('/api/users', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  const { displayName, username, password, role = 'customer' } = req.body;
  const allowedRoles = ['admin', 'staff', 'driver', 'customer'];
  if (!displayName || !username || !password || !allowedRoles.includes(role)) {
    return res.status(400).json({ message: 'Vui lòng nhập đầy đủ thông tin tài khoản.' });
  }

  const existingUser = await dbGet('SELECT id FROM users WHERE username = ?', [username]);
  if (existingUser) return res.status(409).json({ message: 'Username đã tồn tại.' });

  const user = {
    id: `${Date.now()}-${Math.random()}`,
    username: username.trim(),
    passwordHash: bcrypt.hashSync(password, 10),
    role,
    displayName: displayName.trim()
  };

  await dbRun(
    'INSERT INTO users (id, username, passwordHash, role, displayName) VALUES (?, ?, ?, ?, ?)',
    [user.id, user.username, user.passwordHash, user.role, user.displayName]
  );

  res.status(201).json({ message: 'Tài khoản đã được tạo.', user: { id: user.id, username: user.username, role: user.role, displayName: user.displayName } });
});

app.patch('/api/users/:id', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  const { role, displayName } = req.body;
  const allowedRoles = ['admin', 'staff', 'driver', 'customer'];
  if (role && !allowedRoles.includes(role)) return res.status(400).json({ message: 'Vai trò không hợp lệ.' });

  const existing = await dbGet('SELECT id, username, role, displayName FROM users WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ message: 'Không tìm thấy tài khoản.' });

  const nextRole = role || existing.role;
  const nextDisplayName = displayName?.trim() || existing.displayName;
  await dbRun('UPDATE users SET role = ?, displayName = ? WHERE id = ?', [nextRole, nextDisplayName, req.params.id]);

  res.json({ message: 'Tài khoản đã được cập nhật.', user: { ...existing, role: nextRole, displayName: nextDisplayName } });
});

app.delete('/api/users/:id', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ message: 'Không thể xóa chính tài khoản đang đăng nhập.' });
  }

  const result = await dbRun('DELETE FROM users WHERE id = ?', [req.params.id]);
  if (!result.changes) return res.status(404).json({ message: 'Không tìm thấy tài khoản.' });
  res.json({ message: 'Tài khoản đã được xóa.' });
});


app.patch('/api/orders/:orderId/status', authenticateToken, authorizeRole(['admin', 'staff', 'driver', 'customer']), async (req, res) => {
  const { status, note = '' } = req.body;
  const allowed = ['Chờ xác nhận', 'Đã tiếp nhận', 'Đã duyệt', 'Từ chối', 'Hủy đơn', 'Đang xử lý', 'Đang đóng gói', 'Đang ở cảng', 'Sẵn sàng giao', 'Đã phân công', 'Tài xế đã nhận', 'Đang trên đường đến', 'Đang vận chuyển', 'Đang giao', 'Đã giao hàng', 'Hoàn tất'];
  if (!status || !allowed.includes(status)) {
    return res.status(400).json({ message: 'Trạng thái đơn hàng không hợp lệ.' });
  }
  const driverOnlyStatuses = ['Tài xế đã nhận', 'Đang trên đường đến', 'Đang vận chuyển', 'Đang giao', 'Đã giao hàng', 'Hoàn tất'];
  if (['admin', 'staff'].includes(req.user.role) && driverOnlyStatuses.includes(status)) {
    return res.status(403).json({ message: 'Trạng thái giao hàng do tài xế cập nhật ở trang Tài xế. Admin/Staff chỉ duyệt, đóng gói và phân công.' });
  }
  if (req.user.role === 'driver' && !driverOnlyStatuses.includes(status)) {
    return res.status(403).json({ message: 'Tài xế chỉ được cập nhật trạng thái giao hàng.' });
  }
  const existing = await dbGet('SELECT * FROM orders WHERE orderId = ?', [req.params.orderId]);
  if (!existing) return res.status(404).json({ message: 'Không tìm thấy đơn hàng.' });
  if (req.user.role === 'customer') {
    const current = String(existing.status || 'Chờ xác nhận');
    const canCancel = ['Chờ xác nhận', 'Đã tiếp nhận', 'Đã duyệt', 'Đang xử lý'].some(item => current.includes(item));
    if (status !== 'Hủy đơn' || Number(existing.userId) !== Number(req.user.id) || !canCancel) {
      return res.status(403).json({ message: 'Khách hàng chỉ được hủy đơn của mình khi đơn chưa giao.' });
    }
  }
  if (req.user.role === 'driver') {
    const allowedDrivers = Array.from(new Set([req.user.displayName, req.user.username, 'Tài xế Demo'].filter(Boolean)));
    const isDemoDriver = req.user.username === 'taixe' || String(req.user.displayName || '').toLowerCase().includes('tài xế');
    const assignedDriver = String(existing.driver || '');
    const assignedToDemoTeam = isDemoDriver && (assignedDriver.startsWith('Tài xế') || assignedDriver === 'Chưa phân' || !assignedDriver);
    if (!allowedDrivers.includes(assignedDriver) && !assignedToDemoTeam) {
      return res.status(403).json({ message: 'Đơn này chưa được phân cho tài xế hiện tại.' });
    }
  }
  const updatedAt = new Date().toISOString();
  const statusNote = note || `Cập nhật trạng thái bởi ${req.user.displayName || req.user.username}.`;
  const currentLocation = status === 'Hoàn tất'
    ? 'Đã giao đến khách hàng'
    : driverOnlyStatuses.includes(status)
      ? 'Tài xế đang trên đường đến điểm giao'
      : existing.currentLocation;
  await dbRun('UPDATE orders SET status = ?, note = ?, currentLocation = ?, updatedAt = ? WHERE orderId = ?', [status, statusNote, currentLocation, updatedAt, req.params.orderId]);

  let autoResult = null;
  if (status === 'Sẵn sàng giao' && ['admin', 'staff'].includes(req.user.role)) {
    // Chỉ chạy điều phối khi đơn đã sẵn sàng giao, tránh vừa bấm Duyệt là nhảy hết qua tài xế.
    autoResult = await runAutoWarehouseAndDispatch({ orderId: req.params.orderId, actor: req.user.displayName || req.user.username });
  }

  const row = await dbGet('SELECT * FROM orders WHERE orderId = ?', [req.params.orderId]);
  const finalOrder = normalizeOrderRow(row);
  const autoMsg = autoResult && autoResult.assigned
    ? ` Kho và điều phối đã tự động đóng gói, chia chuyến 100kg, gán ${finalOrder.driver}.`
    : '';
  res.json({ message: `Đơn ${req.params.orderId} đã chuyển sang trạng thái: ${finalOrder.status}.${autoMsg}`, order: finalOrder, auto: autoResult });
});

app.get('/api/company/summary', authenticateToken, authorizeRole(['admin', 'staff']), async (req, res) => {
  const orders = await dbAll('SELECT * FROM orders ORDER BY createdAt DESC');
  const products = await dbAll('SELECT * FROM products ORDER BY createdAt DESC');
  const users = await dbAll('SELECT id, username, role, displayName FROM users');
  const revenue = orders.filter(o => String(o.status || '').includes('Hoàn')).reduce((s, o) => s + Number(o.total || 0), 0);
  res.json({
    orders: orders.map(normalizeOrderRow),
    products,
    users,
    metrics: {
      totalOrders: orders.length,
      pendingOrders: orders.filter(o => String(o.status || '').includes('Chờ')).length,
      approvedOrders: orders.filter(o => String(o.status || '').includes('Đã duyệt')).length,
      revenue,
      lowStockProducts: products.filter(p => Number(p.stock || 0) <= 5).length
    }
  });
});


function escapeExcelCell(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.get('/api/orders/report', authenticateToken, authorizeRole(['admin', 'staff']), async (req, res) => {
  const rows = await dbAll('SELECT * FROM orders ORDER BY createdAt DESC');
  const orders = rows.map(normalizeOrderRow);
  const byStatus = orders.reduce((map, order) => {
    const key = order.status || 'Chưa rõ';
    map[key] = (map[key] || 0) + 1;
    return map;
  }, {});
  const revenue = orders
    .filter(order => String(order.status || '').includes('Hoàn'))
    .reduce((sum, order) => sum + Number(order.total || 0), 0);
  res.json({
    total: orders.length,
    byStatus,
    revenue,
    orders
  });
});

app.get('/api/orders/export-excel', authenticateToken, authorizeRole(['admin', 'staff']), async (req, res) => {
  const rows = await dbAll('SELECT * FROM orders ORDER BY createdAt DESC');
  const orders = rows.map(normalizeOrderRow);
  const tableRows = orders.map(order => {
    const itemsText = (order.items || []).map(item => `${item.name || item.id || 'SP'} x${item.quantity || 1}`).join('; ');
    return `<tr>
      <td>${escapeExcelCell(order.orderId)}</td>
      <td>${escapeExcelCell(order.customer)}</td>
      <td>${escapeExcelCell(order.phone)}</td>
      <td>${escapeExcelCell(order.email)}</td>
      <td>${escapeExcelCell(order.companyName)}</td>
      <td>${escapeExcelCell(order.address)}</td>
      <td>${escapeExcelCell(itemsText)}</td>
      <td>${Number(order.total || 0)}</td>
      <td>${escapeExcelCell(order.payment)}</td>
      <td>${escapeExcelCell(order.status)}</td>
      <td>${escapeExcelCell(order.driver)}</td>
      <td>${escapeExcelCell(order.vehicle)}</td>
      <td>${escapeExcelCell(order.route)}</td>
      <td>${escapeExcelCell(order.staffInCharge)}</td>
      <td>${escapeExcelCell(order.createdAt)}</td>
      <td>${escapeExcelCell(order.updatedAt)}</td>
    </tr>`;
  }).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <table border="1">
      <thead><tr>
        <th>Mã đơn</th><th>Khách hàng</th><th>SĐT</th><th>Email</th><th>Công ty</th><th>Địa chỉ</th><th>Sản phẩm</th><th>Tổng tiền</th><th>Thanh toán</th><th>Trạng thái</th><th>Tài xế</th><th>Phương tiện</th><th>Tuyến</th><th>Nhân viên phụ trách</th><th>Ngày tạo</th><th>Cập nhật</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </body></html>`;
  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="logiport_200_don_demo.xls"');
  res.send('\ufeff' + html);
});

app.post('/api/chat', async (req, res) => {
  const { message, history = [], context = {} } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ message: 'Vui lòng nhập nội dung cần hỗ trợ.' });
  }

  const safeHistory = Array.isArray(history)
    ? history.slice(-8).filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
    : [];

  const safeContext = {
    role: context.role || 'guest',
    page: context.page || '',
    cartCount: Number(context.cartCount || 0),
    cartTotal: Number(context.cartTotal || 0),
    cartItems: Array.isArray(context.cartItems) ? context.cartItems.slice(0, 8) : []
  };

  const fallbackReply = buildLocalAiReply(message, safeContext);

  if (!OPENAI_API_KEY || OPENAI_API_KEY.includes('sk-your-openai-api-key')) {
    return res.json({
      reply: fallbackReply + '\n\nGhi chú demo: để bật ChatGPT thật, hãy thêm OPENAI_API_KEY vào file .env rồi chạy lại server.',
      mode: 'local-demo'
    });
  }

  const systemPrompt = `Bạn là LogiPort AI, trợ lý CSKH cho website LogiPort Mart - một Shopee mini kết hợp logistics.
Nhiệm vụ: trả lời ngắn gọn, dễ hiểu bằng tiếng Việt; tư vấn sản phẩm, giỏ hàng, thanh toán, đổi trả, tra cứu đơn, quy trình Admin/Staff/Tài xế và giải thích thuật toán Order Batching + Greedy.
Thông tin hệ thống:
- Tài khoản demo: admin/admin123, nhanvien/nv123456, taixe/tx123456, khachhang/kh123456.
- Luồng đơn: Khách đặt → Admin/Staff duyệt → kho tự đóng gói → điều phối gom xe 100kg → Greedy sắp tuyến → tài xế nhận/giao → hoàn tất.
- Greedy dùng Nearest Neighbor: từ kho/điểm hiện tại chọn điểm giao gần nhất, lặp đến khi hết đơn. Ưu điểm nhanh O(n^2), nhược điểm không chắc tối ưu toàn cục.
- Không bịa mã đơn cụ thể nếu người dùng không cung cấp. Nếu cần thao tác trong hệ thống, hướng dẫn họ vào đúng trang.`;

  const userPrompt = `Ngữ cảnh hiện tại: ${JSON.stringify(safeContext)}\n\nCâu hỏi khách: ${message}`;

  try {
    let reply = '';
    let response;
    let data;

    // Dùng Responses API hiện đại. Nếu tài khoản/model không hỗ trợ, tự fallback sang Chat Completions.
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          { role: 'system', content: systemPrompt },
          ...safeHistory.map(item => ({ role: item.role, content: item.content })),
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.35,
        max_output_tokens: 450
      })
    });

    data = await response.json();
    if (response.ok) {
      reply = data.output_text || (Array.isArray(data.output)
        ? data.output.flatMap(o => o.content || []).map(c => c.text || '').join('\n').trim()
        : '');
    } else if (response.status === 404 || String(data.error?.message || '').toLowerCase().includes('responses')) {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            ...safeHistory,
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.35,
          max_tokens: 450
        })
      });
      data = await response.json();
      if (response.ok) reply = data.choices?.[0]?.message?.content?.trim() || '';
    }

    if (!response.ok) {
      console.error('OpenAI API error:', data);
      const msg = response.status === 401
        ? 'OpenAI API key không hợp lệ. Kiểm tra OPENAI_API_KEY trong .env.'
        : response.status === 429
          ? 'OpenAI API key hết quota/billing. Kiểm tra tài khoản OpenAI.'
          : 'ChatGPT đang bận hoặc model chưa đúng. Bạn thử lại sau.';
      return res.status(502).json({ message: msg, fallback: fallbackReply });
    }

    res.json({ reply: reply || fallbackReply, mode: 'openai' });
  } catch (error) {
    console.error('Chat API error:', error);
    res.json({ reply: fallbackReply + '\n\nChatGPT online đang lỗi kết nối, mình đã trả lời bằng chế độ demo cục bộ.', mode: 'local-fallback' });
  }
});

function buildLocalAiReply(message, context = {}) {
  const text = String(message || '').toLowerCase();
  const money = n => Number(n || 0).toLocaleString('vi-VN') + 'đ';

  if (text.includes('giỏ') || text.includes('gio') || text.includes('cart')) {
    if (!context.cartCount) return 'Giỏ hàng hiện đang trống. Bạn vào trang Sản phẩm, chọn món rồi bấm “Thêm vào giỏ”.';
    const items = (context.cartItems || []).map(i => `- ${i.name} × ${i.quantity}`).join('\n');
    return `Giỏ hàng hiện có ${context.cartCount} sản phẩm, tạm tính ${money(context.cartTotal)}.\n${items}`;
  }

  if (text.includes('greedy') || text.includes('tuyến') || text.includes('tuyen') || text.includes('100kg') || text.includes('đường')) {
    return 'Phần thuật toán chính gồm 2 bước: (1) Order Batching gom các đơn đã duyệt theo khu vực và giới hạn xe tối đa 100kg; (2) Greedy Nearest Neighbor sắp thứ tự giao: từ kho hoặc điểm hiện tại chọn điểm giao gần nhất, cập nhật vị trí rồi lặp lại. Ưu điểm là chạy nhanh O(n²), phù hợp demo 100–200 đơn; nhược điểm là không đảm bảo tối ưu toàn cục như TSP đầy đủ.';
  }

  if (text.includes('đổi trả') || text.includes('doi tra') || text.includes('hoàn tiền')) {
    return 'Đổi trả: khách vào trang Đổi trả, nhập mã đơn và lý do. Admin/Staff xem yêu cầu đổi trả, duyệt hoặc từ chối. Nếu duyệt, hệ thống cập nhật trạng thái để xử lý hoàn tiền/đổi hàng.';
  }

  if (text.includes('đăng nhập') || text.includes('tai khoan') || text.includes('tài khoản')) {
    return 'Tài khoản demo: admin/admin123 để quản trị, nhanvien/nv123456 để Staff, taixe/tx123456 để tài xế, khachhang/kh123456 để khách hàng.';
  }

  if (text.includes('đơn') || text.includes('don') || text.includes('duyệt') || text.includes('duyet')) {
    return 'Luồng đơn hàng: khách đặt đơn → Admin/Staff duyệt → kho tự đóng gói → điều phối gom xe 100kg và phân tài xế → tài xế nhận/giao → khách tra cứu trạng thái.';
  }

  if (text.includes('sản phẩm') || text.includes('san pham') || text.includes('sale') || text.includes('tư vấn')) {
    return 'Bạn có thể tư vấn theo nhu cầu: laptop/điện thoại cho điện tử, áo/quần/giày cho thời trang, thùng carton/pallet/màng PE cho logistics. Vào trang Sản phẩm để lọc và thêm vào giỏ.';
  }

  return 'Mình có thể hỗ trợ: tìm sản phẩm, kiểm tra giỏ hàng, hướng dẫn đặt/duyệt đơn, đổi trả, tài xế nhận chuyến và giải thích thuật toán Greedy giao hàng. Bạn muốn hỏi phần nào?';
}


initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server đang chạy tại http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Server init error:', error);
    process.exit(1);
  });
