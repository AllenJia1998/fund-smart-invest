// ===== 商品数据 =====
const PRODUCTS = [
  { id: 1, name: "无线降噪耳机 Pro", cat: "数码", price: 899, origin: 1299, rating: 4.9, sold: "2.3万", icon: "🎧", grad: ["#e0f2fe", "#bae6fd"], tag: "爆款" },
  { id: 2, name: "智能运动手表 S8", cat: "数码", price: 1499, origin: 1999, rating: 4.8, sold: "1.1万", icon: "⌚", grad: ["#fef3c7", "#fde68a"], tag: "新品" },
  { id: 3, name: "便携蓝牙音箱", cat: "数码", price: 399, origin: 599, rating: 4.7, sold: "8900", icon: "🔊", grad: ["#ede9fe", "#ddd6fe"] },
  { id: 4, name: "北欧原木台灯", cat: "家居", price: 259, origin: 359, rating: 4.9, sold: "1.6万", icon: "💡", grad: ["#fef9c3", "#fde047"], tag: "限时" },
  { id: 5, name: "香薰加湿器", cat: "家居", price: 199, origin: 299, rating: 4.6, sold: "7200", icon: "🌿", grad: ["#dcfce7", "#bbf7d0"] },
  { id: 6, name: "记忆棉护颈枕", cat: "家居", price: 159, origin: 229, rating: 4.8, sold: "2.1万", icon: "🛏️", grad: ["#fce7f3", "#fbcfe8"] },
  { id: 7, name: "简约帆布休闲鞋", cat: "服饰", price: 299, origin: 399, rating: 4.7, sold: "9800", icon: "👟", grad: ["#e0e7ff", "#c7d2fe"] },
  { id: 8, name: "纯棉基础T恤（3件装）", cat: "服饰", price: 99, origin: 159, rating: 4.5, sold: "3.2万", icon: "👕", grad: ["#fee2e2", "#fecaca"], tag: "热卖" },
  { id: 9, name: "大容量双肩电脑包", cat: "服饰", price: 219, origin: 319, rating: 4.8, sold: "1.3万", icon: "🎒", grad: ["#cffafe", "#a5f3fc"] },
  { id: 10, name: "玻尿酸保湿套装", cat: "美妆", price: 359, origin: 499, rating: 4.9, sold: "6800", icon: "🧴", grad: ["#ffe4e6", "#fecdd3"], tag: "爆款" },
  { id: 11, name: "手工现磨咖啡豆", cat: "食品", price: 89, origin: 119, rating: 4.6, sold: "5400", icon: "☕", grad: ["#fef3c7", "#fed7aa"] },
  { id: 12, name: "智能体脂秤", cat: "运动", price: 129, origin: 199, rating: 4.7, sold: "7600", icon: "⚖️", grad: ["#d1fae5", "#a7f3d0"] },
];

// ===== 工具 =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const fmt = (n) => "¥" + n.toLocaleString("zh-CN");

// ===== 购物车状态 =====
let cart = JSON.parse(localStorage.getItem("nova_cart") || "[]");

function saveCart() {
  localStorage.setItem("nova_cart", JSON.stringify(cart));
  renderCart();
  renderCartCount();
}

function cartQty() {
  return cart.reduce((s, i) => s + i.qty, 0);
}

// ===== Toast =====
let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// ===== 渲染商品 =====
function renderProducts(cat = "all") {
  const grid = $("#productGrid");
  const list = cat === "all" ? PRODUCTS : PRODUCTS.filter((p) => p.cat === cat);
  grid.innerHTML = list
    .map(
      (p) => `
      <article class="card" data-id="${p.id}">
        <div class="card-thumb" style="background:linear-gradient(135deg,${p.grad[0]},${p.grad[1]})">
          ${p.tag ? `<span class="card-tag">${p.tag}</span>` : ""}
          <span>${p.icon}</span>
        </div>
        <div class="card-body">
          <span class="card-cat">${p.cat}</span>
          <h3 class="card-name">${p.name}</h3>
          <div class="card-rating">★ ${p.rating} <span>已售 ${p.sold}</span></div>
          <div class="card-price">
            <strong>${fmt(p.price)}</strong>
            <del>${fmt(p.origin)}</del>
          </div>
          <button class="card-add" data-add="${p.id}">加入购物车</button>
        </div>
      </article>`
    )
    .join("");
}

// ===== 渲染购物车 =====
function renderCart() {
  const body = $("#cartBody");
  const foot = $("#cartFoot");
  $("#cartHeadCount").textContent = `(${cartQty()})`;

  if (cart.length === 0) {
    body.innerHTML = `
      <div class="cart-empty">
        <span>🛒</span>
        <p>购物车还是空的，去挑点好物吧～</p>
      </div>`;
    foot.style.display = "none";
    return;
  }

  foot.style.display = "block";
  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
  $("#cartTotal").textContent = fmt(total);

  body.innerHTML = cart
    .map(
      (i) => `
      <div class="cart-item" data-id="${i.id}">
        <div class="cart-item-thumb" style="background:linear-gradient(135deg,${i.grad[0]},${i.grad[1]})">${i.icon}</div>
        <div class="cart-item-info">
          <div class="cart-item-name">${i.name}</div>
          <div class="cart-item-price">${fmt(i.price)}</div>
          <div class="cart-item-actions">
            <button class="qty-btn" data-dec="${i.id}">−</button>
            <span class="qty">${i.qty}</span>
            <button class="qty-btn" data-inc="${i.id}">+</button>
            <button class="cart-item-remove" data-del="${i.id}">移除</button>
          </div>
        </div>
      </div>`
    )
    .join("");
}

function renderCartCount() {
  const el = $("#cartCount");
  el.textContent = cartQty();
  el.classList.add("bump");
  setTimeout(() => el.classList.remove("bump"), 200);
}

// ===== 购物车操作 =====
function addToCart(id) {
  const p = PRODUCTS.find((x) => x.id === id);
  const item = cart.find((i) => i.id === id);
  if (item) item.qty += 1;
  else cart.push({ id, name: p.name, price: p.price, icon: p.icon, grad: p.grad, qty: 1 });
  saveCart();
  toast(`已加入购物车：${p.name}`);
  openCart();
}

function changeQty(id, delta) {
  const item = cart.find((i) => i.id === id);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) cart = cart.filter((i) => i.id !== id);
  saveCart();
}

function removeItem(id) {
  cart = cart.filter((i) => i.id !== id);
  saveCart();
}

// ===== 抽屉 =====
function openCart() {
  $("#cartDrawer").classList.add("open");
  $("#overlay").classList.add("open");
}
function closeCart() {
  $("#cartDrawer").classList.remove("open");
  $("#overlay").classList.remove("open");
}

// ===== 事件绑定 =====
document.addEventListener("click", (e) => {
  const add = e.target.closest("[data-add]");
  if (add) return addToCart(+add.dataset.add);

  const inc = e.target.closest("[data-inc]");
  if (inc) return changeQty(+inc.dataset.inc, 1);

  const dec = e.target.closest("[data-dec]");
  if (dec) return changeQty(+dec.dataset.dec, -1);

  const del = e.target.closest("[data-del]");
  if (del) return removeItem(+del.dataset.del);
});

$("#cartBtn").addEventListener("click", openCart);
$("#cartClose").addEventListener("click", closeCart);
$("#overlay").addEventListener("click", closeCart);
document.addEventListener("keydown", (e) => e.key === "Escape" && closeCart());

// 分类筛选
$("#filters").addEventListener("click", (e) => {
  const chip = e.target.closest(".filter-chip");
  if (!chip) return;
  $$(".filter-chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
  renderProducts(chip.dataset.cat);
});

// 结算（演示）
$("#checkoutBtn").addEventListener("click", () => {
  toast("🎉 这是演示站点，结算功能即将上线～");
});

// 订阅
$("#newsletterForm").addEventListener("submit", (e) => {
  e.preventDefault();
  toast("✅ 订阅成功，感谢关注！");
  e.target.reset();
});

// 导航高亮
const sections = $$("main section[id]");
const navLinks = $$(".nav a");
window.addEventListener("scroll", () => {
  let cur = "";
  sections.forEach((s) => {
    if (window.scrollY >= s.offsetTop - 120) cur = s.id;
  });
  navLinks.forEach((a) => {
    a.classList.toggle("active", a.getAttribute("href") === "#" + cur);
  });
});

// ===== 初始化 =====
renderProducts();
renderCart();
renderCartCount();
