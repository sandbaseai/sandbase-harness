import { useState } from 'react';
import { Modal } from './Modal';

/**
 * One confirmation shape for every destructive action. States the consequence
 * rather than asking "are you sure", shows a busy label while the request is
 * in flight, and surfaces the API error in place instead of silently closing.
 */
export function ConfirmDeleteModal({
  title,
  subject,
  consequence,
  confirmLabel,
  verb,
  onClose,
  onConfirm,
}: {
  title: string;
  /** What is being deleted, rendered bold inside the sentence. */
  subject: string;
  /** Plain-language consequence, e.g. "Sessions that already ran keep their history." */
  consequence: string;
  confirmLabel?: string;
  /**
   * The verb the sentence leads with — "Archive" for routes whose DELETE is
   * archival rather than physical removal, so the confirmation never promises
   * an effect the API does not have.
   */
  verb?: string;
  onClose: () => void;
  /** Return a promise that resolves when the delete completes; rejections render inline. */
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <div className="modalForm">
        {error ? <div className="banner error inlineBanner" role="alert">{error}</div> : null}
        <p className="modalBody">
          {verb ?? 'Delete'} <strong>{subject}</strong>? {consequence}
        </p>
        <div className="modalActions">
          <button className="secondaryButton" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="dangerButton" type="button" onClick={() => void run()} disabled={busy}>
            {busy ? 'Deleting…' : (confirmLabel ?? title)}
          </button>
        </div>
      </div>
    </Modal>
  );
}
