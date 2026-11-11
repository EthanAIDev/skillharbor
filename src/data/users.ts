/**
 * Fallback roster for UI when the departments API is unreachable.
 * Not used for authentication — accounts come from the server seed / DATA_DIR.
 */
export interface User {
  id: string;
  username: string;
  name: string;
  dept: string;
  deptShort: string;
  title?: string;
  phone?: string;
  email?: string;
  role: 'user' | 'admin';
  disabled?: boolean;
}

export const DEFAULT_PASSWORD = '123456';
export const ADMIN_PASSWORD = 'admin123';

export const baseUsers: User[] = [
  { id: '0', username: 'admin', name: 'Administrator', dept: 'Platform', deptShort: 'Platform', title: 'Admin', role: 'admin' },
  { id: '1', username: 'alice', name: 'Alice Demo', dept: 'Engineering', deptShort: 'Engineering', title: 'Engineer', role: 'user' },
  { id: '2', username: 'bob', name: 'Bob Demo', dept: 'Operations', deptShort: 'Operations', title: 'Operator', role: 'user' },
];
