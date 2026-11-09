import { useEffect, useState } from "react";
import { getBookmarklets } from "../api.js";
import Bookmarklet from "./Bookmarklet.jsx";

export default function BookmarkletsView() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    getBookmarklets()
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch(() => setItems([]));
  }, []);
  return (
    <section aria-label="Bookmarklets" className="flex-1 overflow-y-auto bg-white p-6 dark:bg-slate-900">
      <h2 className="mb-4 text-lg font-semibold">Bookmarklets</h2>
      <Bookmarklet items={items} />
      <p className="mt-4 max-w-2xl text-xs text-slate-500">
        To report back from an application page, a bookmarklet opens <code>/act#&lt;JSON&gt;</code> with{" "}
        <code>{'{"op": "unblock" | "submitted", "job_id"?, "url"?, "title"?}'}</code>. The job is found by id,
        then by <code>#&lt;id&gt;</code> in the page title, then by the page URL.
      </p>
    </section>
  );
}
