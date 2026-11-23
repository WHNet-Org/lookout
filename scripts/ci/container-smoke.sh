#!/bin/sh
set -eu

image=${1:?usage: container-smoke.sh IMAGE VERSION SHA}
version=${2:?missing version}
commit=${3:?missing source SHA}
name=lookout-smoke-${CI_JOB_ID:-local}-$$
app=$name-app
config=$name-config
data=$name-data

cleanup() {
    docker rm -f "$app" >/dev/null 2>&1 || :
    docker volume rm "$config" "$data" >/dev/null 2>&1 || :
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker volume create "$config" >/dev/null
docker volume create "$data" >/dev/null
docker run --rm -i --network none --user 0 --entrypoint sh \
    --mount "type=volume,source=$config,target=/config" "$image" \
    -ec 'cat > /config/monitors.json; chmod 0444 /config/monitors.json' <<'JSON'
{"checks":[{"id":"loopback","name":"Container smoke service","type":"tcp","host":"127.0.0.1","port":8787,"visibility":"public"}],"groups":[{"id":"smoke","name":"Container smoke","checks":["loopback"],"visibility":"detailed"}],"defaultGroup":"smoke"}
JSON

app_ready() {
    docker exec "$app" node --input-type=module -e '
        import assert from "node:assert/strict";
        const origin = "http://127.0.0.1:8787";
        const options = { signal: AbortSignal.timeout(2000) };
        const health = await fetch(origin + "/healthz", options);
        assert.equal(health.status, 200);
        const { version, revision } = await health.json();
        assert.equal(version, process.argv[1]);
        assert.equal(revision, process.argv[2]);
        const status = await fetch(origin + "/api/v1/status?check=loopback", options);
        assert.equal(status.status, 200);
        assert.deepEqual(await status.json(), { online: true, status: "operational" });
        assert.notEqual(process.getuid(), 0);
    ' "$version" "$commit"
}

start_app() {
    docker run -d --name "$app" --network none \
        --mount "type=volume,source=$config,target=/etc/lookout,readonly" \
        --mount "type=volume,source=$data,target=/var/lib/lookout" "$image" >/dev/null
    attempts=0
    until app_ready >/dev/null 2>&1; do
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 25 ]; then
            docker logs --tail 30 "$app" >&2
            app_ready >&2 || :
            return 1
        fi
        sleep 1
    done
    docker exec "$app" sh -ec 'test ! -w "$LOOKOUT_CONFIG"'
    test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/lookout"}}{{.RW}}{{end}}{{end}}' "$app")" = false
}

start_app
docker exec "$app" node --input-type=module -e '
    import assert from "node:assert/strict";
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync(process.env.LOOKOUT_DB);
    assert(database.prepare("SELECT COUNT(*) AS count FROM runs").get().count > 0);
    database.exec("CREATE TABLE smoke_persistence (marker TEXT)");
    database.prepare("INSERT INTO smoke_persistence VALUES (?)").run("first-container");
    database.close();
'
docker stop --time 15 "$app" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$app")" = 0
docker rm "$app" >/dev/null

start_app
docker exec "$app" node --input-type=module -e '
    import assert from "node:assert/strict";
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync(process.env.LOOKOUT_DB, { readOnly: true });
    assert.equal(database.prepare("SELECT marker FROM smoke_persistence").get().marker, "first-container");
    database.close();
'
printf '%s\n' 'Container served its build identity and mounted check, then reopened the same SQLite data.'
