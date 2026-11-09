// Ma trận phân quyền theo shop. Máy chủ luôn là nơi quyết định; giao diện chỉ ẩn/hiện nút để hướng dẫn.
// Vai trò trong shop: owner (Chủ shop), manager (Quản lý shop), content (Nhân viên nội dung),
// support (Nhân viên CSKH), viewer (Chỉ xem). Quản trị nền tảng là cờ toàn cục, không phải vai trò trong shop.
export const ROLES = ['owner', 'manager', 'content', 'support', 'viewer'];
export const ROLE_LABELS = { owner: 'Chủ shop', manager: 'Quản lý shop', content: 'Nhân viên nội dung', support: 'Nhân viên CSKH', viewer: 'Chỉ xem' };
export const ACTIONS = [
  'shop.view', 'shop.update', 'shop.delete', 'shop.transfer',
  'members.view', 'members.invite', 'members.update_role', 'members.remove',
  'channels.view', 'channels.configure_token', 'channels.operate',
  'drafts.view', 'drafts.create', 'drafts.edit_own', 'drafts.edit_any', 'drafts.submit', 'drafts.approve', 'drafts.publish', 'drafts.delete',
  'ai.use',
  'conversations.view_assigned', 'conversations.reply', 'conversations.assign',
  'reports.view',
  'admin.overview', 'admin.shops', 'admin.audit'
];
const ADMIN_ACTIONS = ACTIONS.filter(a => a.startsWith('admin.'));
const SHOP_ACTIONS = ACTIONS.filter(a => !a.startsWith('admin.'));
// Ma trận tường minh: mỗi vai trò liệt kê đúng những hành động được phép trong shop của mình.
const MATRIX = {
  owner: new Set(SHOP_ACTIONS),
  manager: new Set([
    'shop.view', 'shop.update',
    'members.view',
    'channels.view', 'channels.configure_token', 'channels.operate',
    'drafts.view', 'drafts.create', 'drafts.edit_own', 'drafts.edit_any', 'drafts.submit', 'drafts.approve', 'drafts.publish', 'drafts.delete',
    'ai.use',
    'conversations.view_assigned', 'conversations.reply', 'conversations.assign',
    'reports.view'
  ]),
  content: new Set([
    'shop.view', 'members.view', 'channels.view',
    'drafts.view', 'drafts.create', 'drafts.edit_own', 'drafts.submit',
    'ai.use'
  ]),
  support: new Set([
    'shop.view', 'members.view', 'channels.view',
    'ai.use',
    'conversations.view_assigned', 'conversations.reply'
  ]),
  viewer: new Set([
    'shop.view', 'members.view', 'channels.view',
    'drafts.view',
    'reports.view'
  ])
};
// Nhân viên nội dung được cờ can_publish thì thêm quyền duyệt và đăng.
const CAN_PUBLISH_EXTRA = new Set(['drafts.approve', 'drafts.publish']);

export const isRole = role => ROLES.includes(role);
export const isAction = action => ACTIONS.includes(action);

// membership: { role, can_publish } (hàng shop_members). Hành động admin.* không bao giờ được cấp qua vai trò shop.
export function can(membership, action) {
  if (!membership || !isRole(membership.role) || !isAction(action)) return false;
  if (ADMIN_ACTIONS.includes(action)) return false;
  if (MATRIX[membership.role].has(action)) return true;
  return membership.role === 'content' && Boolean(membership.can_publish) && CAN_PUBLISH_EXTRA.has(action);
}

// Danh sách hành động được phép, dùng để trả về cho giao diện.
export const allowedActions = membership => SHOP_ACTIONS.filter(action => can(membership, action));

export function adminEmails(env) {
  return String(env?.PLATFORM_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}
// Quản trị nền tảng: danh tính có email đã xác minh (đăng nhập email OTP hoặc Access có claim email) nằm trong PLATFORM_ADMIN_EMAILS.
export function isPlatformAdmin(env, who) {
  const email = typeof who?.email === 'string' ? who.email.trim().toLowerCase() : '';
  if (!email || !who?.emailVerified) return false;
  return adminEmails(env).includes(email);
}
export const canAdmin = (env, who, action) => ADMIN_ACTIONS.includes(action) && isPlatformAdmin(env, who);
