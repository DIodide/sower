import { describe, expect, it, vi } from 'vitest';

// buildSystemPrompt is pure; stub the SDK so importing the module never
// drags the real agent runtime into the test process.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import { buildSystemPrompt } from './agent-session.js';

describe('buildSystemPrompt', () => {
  const texPath = 'developer/resumes/Ibraheem_Amin_Resume.tex';

  it('submodule checkout: instructs the two-repo commit/push + pointer bump', () => {
    const prompt = buildSystemPrompt(texPath, true);
    expect(prompt).toContain(texPath);
    expect(prompt).toContain('developer/resumes submodule');
    expect(prompt).toContain('bump the submodule pointer');
  });

  it('plain directory: states developer/resumes is part of THIS repo and never asks for a pointer bump', () => {
    const prompt = buildSystemPrompt(texPath, false);
    expect(prompt).toContain(texPath);
    expect(prompt).toContain(
      'developer/resumes is part of this repository (not a submodule)',
    );
    expect(prompt).toContain('a single commit and push covers everything');
    expect(prompt).not.toContain('bump the submodule pointer');
    // The tectonic verification step survives in both variants.
    expect(prompt).toContain('tectonic');
  });
});
