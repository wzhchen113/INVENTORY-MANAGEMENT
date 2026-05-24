// src/__mocks__/useEodSubmit.ts — jest manual mock per spec 062 §0 Q5.
//
// Screen tests opt into this via `jest.mock('../hooks/useEodSubmit')`.
// Default return is { submit: jest.fn(), pending: 0, draining: false };
// per-test overrides use `jest.mocked(useEodSubmit).mockReturnValue(...)`.

export const useEodSubmit = jest.fn(() => ({
  submit: jest.fn().mockResolvedValue({ kind: 'success', submission_id: 'mock-id' }),
  pending: 0,
  draining: false,
}));
