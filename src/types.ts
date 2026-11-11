export type ToolType = 'external' | 'local' | 'coze' | 'download' | 'service';

export interface Tool {
  id: string;
  name: string;
  desc: string;
  department: string;
  owner: string;
  url: string;
  type: ToolType;
  icon: string; // 卡片右上角字块图标（用户上传工具最多 2 字符）
  iconUrl?: string; // 网页图标（外部链接自动抓取 favicon）
  iconBg?: string; // 文字图标背景色（如 #EEEAFE），缺省用部门色
  tags?: string[]; // 业务标签（上传时选择，首页按标签筛选）
  departments?: string[]; // 适用部门（短名多选；['全部'] 表示全部门适用）
  usage: number; // 累计使用次数（基础值）
  likes: number; // 点赞数（基础值）
  approvedAt?: number; // 首次上架精确时间戳（ms）：NEW 标记 / 最新上架排序（员工上传工具）
  shots?: string[]; // 页面截图 URL（≤2 张，首张为卡片缩略图，独立源绝对地址）
  docUrl?: string; // 产品说明书下载 URL（独立源绝对地址）
  onlineAt?: string;
  steps?: string[];
  changelog?: { version: string; date: string; note: string }[];
  faq?: { q: string; a: string }[];
}

export interface Skill {
  kind?: 'agent' | 'skill';
  id: string;
  name: string;
  category: string;
  usage: number;
  icon: string;
  slug?: string;
  desc?: string;
  version?: string;
  owner?: string; // 上传人（技能中心首次上传时记录）
  createdAt?: string; // 首次上架时间（技能中心 created_at，"YYYY-MM-DD HH:mm:ss"）：NEW 标记 / 最新上架排序
  calls7d?: number;
  updatedAt?: string;
  routable?: boolean; // false=内部技能（网关 MCP list_skills 不展示，仅由上层智能体按 slug 分派）
}

export const TYPE_LABELS: Record<ToolType, string> = {
  external: '外部链接',
  local: '本地应用',
  coze: 'Coze 应用',
  download: '下载文件',
  service: '服务应用',
};
