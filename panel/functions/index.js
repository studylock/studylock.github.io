/* eslint-disable no-console */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();

// ✅ CHANGE THIS to your super admin email
const ADMIN_EMAIL = "YOUR_ADMIN_EMAIL_HERE".toLowerCase();

/**
 * Ensures the caller is authenticated and is the super admin.
 */
function assertAdmin(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in.");
  }
  const email = (context.auth.token.email || "").toLowerCase();
  if (!email || email !== ADMIN_EMAIL) {
    throw new functions.https.HttpsError("permission-denied", "Not authorized.");
  }
  return { email };
}

/**
 * Safely trims strings (avoid undefined/null).
 */
function s(x) {
  return (typeof x === "string" ? x.trim() : "");
}

/**
 * Callable: Approve teacher application
 * - Creates Firebase Auth user for teacher (Email/Password)
 * - Writes teachers/{uid} with status=active
 * - Updates teacherApplications/{applicationId} status=approved
 */
exports.approveTeacherApplication = functions.https.onCall(async (data, context) => {
  const adminUser = assertAdmin(context);

  const applicationId = s(data?.applicationId);
  const email = s(data?.email).toLowerCase();
  const tempPassword = s(data?.tempPassword);

  const fullName = s(data?.fullName);
  const schoolName = s(data?.schoolName);
  const country = s(data?.country);

  if (!applicationId) {
    throw new functions.https.HttpsError("invalid-argument", "Missing applicationId.");
  }
  if (!email || !email.includes("@")) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid email.");
  }
  if (!tempPassword || tempPassword.length < 8) {
    throw new functions.https.HttpsError("invalid-argument", "Temp password must be at least 8 characters.");
  }

  const appRef = db.collection("teacherApplications").doc(applicationId);
  const appSnap = await appRef.get();

  if (!appSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Application not found.");
  }

  const appData = appSnap.data() || {};
  const currentStatus = (appData.status || "pending").toLowerCase();

  // If the application email doesn't match, we still allow approval
  // but you can enforce match if you want:
  // if ((appData.email || "").toLowerCase() !== email) { ... }

  let userRecord;
  try {
    // Try to create user
    userRecord = await admin.auth().createUser({
      email,
      password: tempPassword,
      displayName: fullName || undefined,
      emailVerified: false,
      disabled: false,
    });
  } catch (err) {
    // If user already exists, re-use and set/reset password
    const code = err?.errorInfo?.code || err?.code || "";
    if (code.includes("auth/email-already-exists")) {
      const existing = await admin.auth().getUserByEmail(email);
      userRecord = await admin.auth().updateUser(existing.uid, {
        password: tempPassword,
        displayName: fullName || existing.displayName || undefined,
        disabled: false,
      });
    } else {
      console.error("createUser failed:", err);
      throw new functions.https.HttpsError("internal", "Failed to create teacher user.");
    }
  }

  const teacherUid = userRecord.uid;

  // Optional: set a custom claim for later use (nice for future rules)
  // await admin.auth().setCustomUserClaims(teacherUid, { teacher: true });

  // Write teacher profile
  const teacherRef = db.collection("teachers").doc(teacherUid);

  await db.runTransaction(async (tx) => {
    tx.set(
      teacherRef,
      {
        uid: teacherUid,
        email,
        fullName: fullName || appData.fullName || "",
        schoolName: schoolName || appData.schoolName || "",
        country: country || appData.country || "",
        status: "active",
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        approvedBy: adminUser.email,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: appData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    tx.set(
      appRef,
      {
        status: "approved",
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        reviewedBy: adminUser.email,
        teacherUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        // keep history:
        previousStatus: currentStatus,
      },
      { merge: true }
    );
  });

  return {
    ok: true,
    teacherUid,
    email,
  };
});

/**
 * Callable: Reject teacher application
 * - Marks teacherApplications/{applicationId} status=rejected
 */
exports.rejectTeacherApplication = functions.https.onCall(async (data, context) => {
  const adminUser = assertAdmin(context);

  const applicationId = s(data?.applicationId);
  if (!applicationId) {
    throw new functions.https.HttpsError("invalid-argument", "Missing applicationId.");
  }

  const ref = db.collection("teacherApplications").doc(applicationId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError("not-found", "Application not found.");
  }

  await ref.set(
    {
      status: "rejected",
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedBy: adminUser.email,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { ok: true };
});

/**
 * Callable: Delete teacher application
 * - Deletes teacherApplications/{applicationId}
 * (Does NOT delete Auth user or teachers/{uid} — this is just cleanup.)
 */
exports.deleteTeacherApplication = functions.https.onCall(async (data, context) => {
  assertAdmin(context);

  const applicationId = s(data?.applicationId);
  if (!applicationId) {
    throw new functions.https.HttpsError("invalid-argument", "Missing applicationId.");
  }

  const ref = db.collection("teacherApplications").doc(applicationId);
  await ref.delete();

  return { ok: true };
});
