/** Edit the text inside a picture. Owner: IMAGE module. */
export function ImageEditor({ file, onClose }: { file: File; onClose: () => void }) {
  return (
    <div>
      {file.name}
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
