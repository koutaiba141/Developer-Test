// One item per pending invitation. If the list call failed or is empty, nothing is returned and the run ends.
const res = $input.first().json;
const list = Array.isArray(res.data) ? res.data : [];
const accountId = $('Config (invites)').first().json.account_id;

return list
  .filter((r) => r && r.id)
  .map((r) => ({
    json: {
      account_id: accountId,
      request_id: r.id,
      from: r.user ? r.user.display_name : null,
    },
  }));
