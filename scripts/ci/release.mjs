async function publishRelease(env) {
  const tag = env.CI_COMMIT_TAG;
  const revision = env.CI_COMMIT_SHA;
  const digest = env.LOOKOUT_RELEASE_DIGEST;
  if (env.CI_COMMIT_REF_PROTECTED !== "true" || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(tag ?? "") ||
      !/^[0-9a-f]{40}$/u.test(revision ?? "") || !/^sha256:[0-9a-f]{64}$/u.test(digest ?? "") ||
      !env.CI_REGISTRY_IMAGE || !env.CI_JOB_TOKEN || !env.CI_API_V4_URL || !/^\d+$/u.test(env.CI_PROJECT_ID ?? "")) {
    throw new Error("Release requires a protected version tag, tested registry digest, and GitLab job credential.");
  }

  const url = `${env.CI_API_V4_URL}/projects/${env.CI_PROJECT_ID}/releases`;
  const image = `${env.CI_REGISTRY_IMAGE}@${digest}`;
  const description = `Linux amd64 container for commit \`${revision}\`.\n\nPull the tested image by digest.\n\n\`\`\`sh\ndocker pull ${image}\n\`\`\``;
  const options = {
    headers: { "JOB-TOKEN": env.CI_JOB_TOKEN, "Content-Type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  };
  const current = await fetch(`${url}/${encodeURIComponent(tag)}`, options);
  if (current.ok) {
    const release = await current.json();
    if (release.commit?.id !== revision || !release.description?.includes(image)) {
      throw new Error("The existing GitLab Release refers to another commit or image digest.");
    }
    console.log(`GitLab Release ${tag} already records the tested image.`);
    return;
  }
  if (current.status !== 404) throw new Error(`Could not look up the GitLab Release (HTTP ${current.status}).`);
  const created = await fetch(url, {
    ...options,
    method: "POST",
    body: JSON.stringify({ tag_name: tag, name: `Lookout ${tag}`, description }),
  });
  if (!created.ok) throw new Error(`Could not create the GitLab Release (HTTP ${created.status}).`);
  console.log(`Created GitLab Release ${tag} for the tested image.`);
}

try {
  await publishRelease(process.env);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
