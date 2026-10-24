"use strict";
async function work(f) {
  let task = await f.good(f.author, "/tasks", {
    class_id: f.classId,
    subject_id: f.subject,
    title: "观察作品",
    target_type: "coursework",
    target_id: null,
    due_at: new Date(Date.now() + 86400000).toISOString(),
    body: "记录三个可以核验的事实。",
    rubric: [{ key: "evidence", title: "证据", weight: 100 }],
  });
  task = await f.good(f.author, `/tasks/${task._id}/actions`, {
    action: "publish",
    expected_revision: task.revision,
  });
  const head = await f.good(f.student, `/tasks/${task._id}/coursework`, {
    action: "submit",
    expected_revision: 0,
    body: "我的原创观察与实践反思",
  });
  return { task, head, id: head.current_submission_id };
}
module.exports = { work };
