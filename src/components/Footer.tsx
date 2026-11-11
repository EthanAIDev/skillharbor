export default function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto max-w-[1440px] px-8 h-14 flex items-center text-xs text-t3">
        <span>© 2026 SkillHarbor Contributors</span>
        <span className="flex-1" />
        <span>v{__BUILD_VERSION__}</span>
      </div>
    </footer>
  );
}
