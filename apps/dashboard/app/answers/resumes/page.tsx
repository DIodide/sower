// Resume workspace stub: the backend (/resumes routes + server actions in
// ./actions.ts) is wired; the interactive pages land in the next phase.
export default function ResumesPage() {
  return (
    <div>
      <h1 className="page-title">Resumes</h1>
      <p className="page-sub">Connect your resume repo — coming online next.</p>
      <div className="card">
        <p className="hint" style={{ margin: 0 }}>
          This is where the LaTeX resumes in your portfolio repo will sync,
          compile, and take edit requests. The backend is wired; the editor
          pages arrive in the next phase.
        </p>
      </div>
    </div>
  );
}
