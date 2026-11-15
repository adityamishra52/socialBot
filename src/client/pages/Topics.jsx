import { useEffect, useState } from "react";
import { api } from "../api.js";
import { ErrorNote } from "../shared.jsx";

export default function Topics({ refreshMe }) {
  const [text, setText] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    api("/api/topics").then((data) => setText(data.text)).catch(setError);
  }, []);

  async function save() {
    setError(null);
    setMessage("");
    try {
      const { count } = await api("/api/topics", { method: "PUT", json: { text } });
      setMessage(`Saved ${count} ${count === 1 ? "topic" : "topics"}.`);
      refreshMe();
    } catch (failure) {
      setError(failure);
    }
  }

  return (
    <section className="card">
      <h1>Topics</h1>
      <p className="muted-text">One topic per line. Lines starting with # are ignored. When you leave the topic blank on the Compose page, the next line is used.</p>
      <ErrorNote error={error} />
      {text !== null && (
        <>
          <label htmlFor="topics" className="sr-only">Topics</label>
          <textarea id="topics" rows={14} value={text} onChange={(e) => { setText(e.target.value); setMessage(""); }} />
          <div className="actions">
            <button className="primary" onClick={save}>Save topics</button>
            {message && <span role="status">{message}</span>}
          </div>
        </>
      )}
    </section>
  );
}
