import { lazy, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import Nav from './components/Nav';
import Footer from './components/Footer';
import UpdateToast from './components/UpdateToast';
import BackToTop from './components/BackToTop';
import Home from './pages/Home';
import { PageLoader } from './components/PageLoader';

const ToolDetail = lazy(() => import('./pages/ToolDetail'));
const Admin = lazy(() => import('./pages/Admin'));
const Login = lazy(() => import('./pages/Login'));
const Workbench = lazy(() => import('./pages/Workbench'));
const ApiHub = lazy(() => import('./pages/ApiHub'));
const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase'));

/** 首次进入的短 splash，强化「应用正在加载」的感知 */
function Splash() {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const t1 = setTimeout(() => setGone(true), 500);
    return () => clearTimeout(t1);
  }, []);
  if (gone) return null;
  return (
    <div className="splash">
      <div className="splash-mark">Z</div>
    </div>
  );
}

/** 路由切换时的顶部进度条 */
function RouteProgress() {
  const location = useLocation();
  const [key, setKey] = useState('');
  useEffect(() => {
    setKey(location.pathname + location.search + Date.now());
  }, [location]);
  if (!key) return null;
  return <div className="route-progress" key={key} />;
}

function Shell() {
  const { session } = useAuth();
  const location = useLocation();

  return (
    <>
      <Splash />
      <RouteProgress />
      <UpdateToast />
      <Routes>
        <Route path="/login" element={session ? <Navigate to="/" replace /> : <PageLoader><Login /></PageLoader>} />
        {/* 管理后台：保留门户顶栏 Nav，其余区域独占（自带固定侧边栏，仅内容区滚动） */}
        <Route
          path="/admin/*"
          element={
            <div className="h-screen flex flex-col overflow-hidden">
              <Nav />
              <div className="flex-1 min-h-0">
                {session ? <PageLoader><Admin /></PageLoader> : <Navigate to="/login" state={{ from: '/admin' }} replace />}
              </div>
            </div>
          }
        />
        <Route
          path="*"
          element={
            <div className="min-h-screen flex flex-col">
              <Nav />
              {/* key=pathname：路由切换时重新挂载，重播与首页一致的淡入加载效果 */}
              <div className="flex-1 page-enter" key={location.pathname}>
                <PageLoader><Routes>
                  {/* 浏览免登录 */}
                  <Route path="/" element={<Home />} />
                  <Route path="/tool/:id" element={<ToolDetail />} />
                  {/* 接口中心：接口广场 + 云侧通道（需登录，后端 API 亦校验） */}
                  <Route
                    path="/apihub"
                    element={
                      session ? (
                        <ApiHub />
                      ) : (
                        <Navigate to="/login" state={{ from: '/apihub' }} replace />
                      )
                    }
                  />
                  {/* 知识库独立页（需登录：/api/kb/* 按会话用户校验权限） */}
                  <Route
                    path="/kb"
                    element={
                      session ? (
                        <KnowledgeBase />
                      ) : (
                        <Navigate to="/login" state={{ from: '/kb' }} replace />
                      )
                    }
                  />
                  {/* 工作台需要登录，未登录跳登录页并记录来路 */}
                  <Route
                    path="/workbench"
                    element={
                      session ? (
                        <Workbench />
                      ) : (
                        <Navigate to="/login" state={{ from: '/workbench' }} replace />
                      )
                    }
                  />
                </Routes></PageLoader>
              </div>
              <Footer />
            </div>
          }
        />
      </Routes>
      <BackToTop />
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
