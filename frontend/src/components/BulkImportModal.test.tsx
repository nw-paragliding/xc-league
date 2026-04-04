// =============================================================================
// BulkImportModal.test.tsx
// =============================================================================

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BulkImportModal from './BulkImportModal';

// ── API mock ──────────────────────────────────────────────────────────────────

vi.mock('../api/leagues', () => ({
  leagueApi: {
    cupPreview: vi.fn(),
    bulkImport: vi.fn(),
  },
}));

import { leagueApi } from '../api/leagues';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PREVIEW_RESPONSE = {
  tasks: [
    { index: 0, name: 'Apr Drag Race', turnpointCount: 4, turnpoints: [] },
    { index: 1, name: 'May Highlands', turnpointCount: 4, turnpoints: [] },
    { index: 2, name: 'Jun Squawking', turnpointCount: 6, turnpoints: [] },
  ],
};

function makeCupFile(name = 'season.cup') {
  return new File(['dummy cup content'], name, { type: 'text/plain' });
}

const DEFAULT_PROPS = {
  leagueSlug: 'nwxc',
  seasonId: 'season-123',
  onSuccess: vi.fn(),
  onClose: vi.fn(),
};

function renderModal(props = DEFAULT_PROPS) {
  return render(<BulkImportModal {...props} />);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BulkImportModal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── Step 1: upload ──────────────────────────────────────────────────────────

  describe('upload step', () => {
    it('renders the upload step initially', () => {
      renderModal();
      expect(screen.getByText('Bulk Import from .cup')).toBeInTheDocument();
      expect(screen.getByText(/Drop a SeeYou/)).toBeInTheDocument();
    });

    it('rejects non-.cup files with an error message', async () => {
      renderModal();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      const txtFile = new File(['not a cup'], 'task.xctsk', { type: 'text/plain' });

      // Bypass the accept attribute (jsdom enforces it; fire change directly)
      Object.defineProperty(input, 'files', { value: [txtFile], configurable: true });
      fireEvent.change(input);

      await waitFor(() => {
        expect(screen.getByText(/Please select a .cup file/i)).toBeInTheDocument();
      });
      expect(leagueApi.cupPreview).not.toHaveBeenCalled();
    });

    it('calls cupPreview when a .cup file is selected', async () => {
      vi.mocked(leagueApi.cupPreview).mockResolvedValue(PREVIEW_RESPONSE);

      renderModal();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(input, makeCupFile());

      await waitFor(() => {
        expect(leagueApi.cupPreview).toHaveBeenCalledWith('nwxc', 'season-123', expect.any(File));
      });
    });

    it('shows error if preview API fails', async () => {
      vi.mocked(leagueApi.cupPreview).mockRejectedValue(new Error('Server error'));

      renderModal();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(input, makeCupFile());

      await waitFor(() => {
        expect(screen.getByText('Server error')).toBeInTheDocument();
      });
    });

    it('shows error and stays on upload step if no tasks found', async () => {
      vi.mocked(leagueApi.cupPreview).mockResolvedValue({ tasks: [] });

      renderModal();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(input, makeCupFile());

      await waitFor(() => {
        expect(screen.getByText(/No tasks found/i)).toBeInTheDocument();
      });
      // Still on upload step
      expect(screen.getByText(/Drop a SeeYou/)).toBeInTheDocument();
    });
  });

  // ── Step 2: configure ──────────────────────────────────────────────────────

  describe('configure step (after successful preview)', () => {
    async function goToConfigureStep() {
      vi.mocked(leagueApi.cupPreview).mockResolvedValue(PREVIEW_RESPONSE);
      renderModal();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(input, makeCupFile());
      await waitFor(() => {
        expect(screen.queryByText(/Drop a SeeYou/)).not.toBeInTheDocument();
      });
    }

    it('shows task names from preview', async () => {
      await goToConfigureStep();
      expect(screen.getByDisplayValue('Apr Drag Race')).toBeInTheDocument();
      expect(screen.getByDisplayValue('May Highlands')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Jun Squawking')).toBeInTheDocument();
    });

    it('shows turnpoint counts', async () => {
      await goToConfigureStep();
      // Two tasks have 4 TPs, one has 6
      expect(screen.getAllByText('4 turnpoints')).toHaveLength(2);
      expect(screen.getByText('6 turnpoints')).toBeInTheDocument();
    });

    it('all tasks are selected by default', async () => {
      await goToConfigureStep();
      const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
      expect(checkboxes.every((cb) => cb.checked)).toBe(true);
    });

    it('import button reflects selected count', async () => {
      await goToConfigureStep();
      expect(screen.getByRole('button', { name: /Import 3 Tasks/i })).toBeInTheDocument();
    });

    it('deselecting a task updates the button count', async () => {
      await goToConfigureStep();
      const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
      await userEvent.click(checkboxes[0]); // deselect first
      expect(screen.getByRole('button', { name: /Import 2 Tasks/i })).toBeInTheDocument();
    });

    it('import button is disabled when no tasks are selected', async () => {
      await goToConfigureStep();
      const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
      for (const cb of checkboxes) await userEvent.click(cb);
      const btn = screen.getByRole('button', { name: /Import 0 Tasks/i });
      expect(btn).toBeDisabled();
    });

    it('← Back returns to upload step', async () => {
      await goToConfigureStep();
      await userEvent.click(screen.getByRole('button', { name: /← Back/i }));
      expect(screen.getByText(/Drop a SeeYou/)).toBeInTheDocument();
    });

    it('allows editing task names', async () => {
      await goToConfigureStep();
      const nameInput = screen.getByDisplayValue('Apr Drag Race');
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'April Task');
      expect(screen.getByDisplayValue('April Task')).toBeInTheDocument();
    });
  });

  // ── Bulk import submission ─────────────────────────────────────────────────

  describe('bulk import submission', () => {
    async function goToConfigureStep() {
      vi.mocked(leagueApi.cupPreview).mockResolvedValue(PREVIEW_RESPONSE);
      renderModal();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(input, makeCupFile());
      await waitFor(() => {
        expect(screen.queryByText(/Drop a SeeYou/)).not.toBeInTheDocument();
      });
    }

    it('calls bulkImport with all selected tasks', async () => {
      vi.mocked(leagueApi.bulkImport).mockResolvedValue({ created: 3, taskIds: ['a', 'b', 'c'] });
      await goToConfigureStep();

      await userEvent.click(screen.getByRole('button', { name: /Import 3 Tasks/i }));

      await waitFor(() => {
        expect(leagueApi.bulkImport).toHaveBeenCalledWith(
          'nwxc',
          'season-123',
          expect.any(File),
          expect.arrayContaining([
            expect.objectContaining({ index: 0 }),
            expect.objectContaining({ index: 1 }),
            expect.objectContaining({ index: 2 }),
          ]),
        );
      });
    });

    it('only sends selected tasks to bulkImport', async () => {
      vi.mocked(leagueApi.bulkImport).mockResolvedValue({ created: 2, taskIds: ['a', 'b'] });
      await goToConfigureStep();

      // Deselect first task
      const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
      await userEvent.click(checkboxes[0]);

      await userEvent.click(screen.getByRole('button', { name: /Import 2 Tasks/i }));

      await waitFor(() => {
        const [, , , payload] = vi.mocked(leagueApi.bulkImport).mock.calls[0];
        expect(payload).toHaveLength(2);
        expect(payload.map((t: any) => t.index)).not.toContain(0);
      });
    });

    it('includes edited name in the payload', async () => {
      vi.mocked(leagueApi.bulkImport).mockResolvedValue({ created: 3, taskIds: [] });
      await goToConfigureStep();

      const nameInput = screen.getByDisplayValue('Apr Drag Race');
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'Spring Opener');

      await userEvent.click(screen.getByRole('button', { name: /Import 3 Tasks/i }));

      await waitFor(() => {
        const [, , , payload] = vi.mocked(leagueApi.bulkImport).mock.calls[0];
        const first = (payload as any[]).find((t) => t.index === 0);
        expect(first.name).toBe('Spring Opener');
      });
    });

    it('calls onSuccess after a successful import', async () => {
      const onSuccess = vi.fn();
      vi.mocked(leagueApi.cupPreview).mockResolvedValue(PREVIEW_RESPONSE);
      vi.mocked(leagueApi.bulkImport).mockResolvedValue({ created: 3, taskIds: [] });

      render(<BulkImportModal {...DEFAULT_PROPS} onSuccess={onSuccess} />);
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(input, makeCupFile());
      await waitFor(() => expect(screen.queryByText(/Drop a SeeYou/)).not.toBeInTheDocument());

      await userEvent.click(screen.getByRole('button', { name: /Import 3 Tasks/i }));
      await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    });

    it('shows error and stays on configure step if import fails', async () => {
      vi.mocked(leagueApi.bulkImport).mockRejectedValue(new Error('DB error'));
      await goToConfigureStep();

      await userEvent.click(screen.getByRole('button', { name: /Import 3 Tasks/i }));

      await waitFor(() => {
        expect(screen.getByText('DB error')).toBeInTheDocument();
      });
      // Still on configure step
      expect(screen.getByDisplayValue('Apr Drag Race')).toBeInTheDocument();
    });
  });

  // ── Keyboard / accessibility ───────────────────────────────────────────────

  describe('keyboard & close', () => {
    it('calls onClose when Escape is pressed', async () => {
      const onClose = vi.fn();
      render(<BulkImportModal {...DEFAULT_PROPS} onClose={onClose} />);
      await userEvent.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('calls onClose when × button is clicked', async () => {
      const onClose = vi.fn();
      render(<BulkImportModal {...DEFAULT_PROPS} onClose={onClose} />);
      await userEvent.click(screen.getByRole('button', { name: '×' }));
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('calls onClose when backdrop is clicked', async () => {
      const onClose = vi.fn();
      const { container } = render(<BulkImportModal {...DEFAULT_PROPS} onClose={onClose} />);
      const backdrop = container.firstChild as HTMLElement;
      fireEvent.click(backdrop, { target: backdrop });
      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});
