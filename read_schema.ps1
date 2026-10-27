$conn = New-Object System.Data.SQLite.SQLiteConnection("Data Source=database/isking_panel.sqlite")
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT sql FROM sqlite_master WHERE type='table' AND name='auth_sessions'"
$reader = $cmd.ExecuteReader()
while ($reader.Read()) { Write-Host $reader.GetString(0) }
$conn.Close()
Write-Host "---"
Write-Host "Sample rows:"
$cmd2 = $conn.CreateCommand()
$cmd2.CommandText = "SELECT * FROM auth_sessions LIMIT 3"
$reader2 = $cmd2.ExecuteReader()
while ($reader2.Read()) { Write-Host ("id={0} user_id={1} session_id={2} username={3} role={4} provider={5} ip_address={6} platform={7} created_at={8} last_active_at={9}" -f $reader2.GetValue(0), $reader2.GetValue(1), $reader2.GetValue(2), $reader2.GetValue(3), $reader2.GetValue(4), $reader2.GetValue(5), $reader2.GetValue(6), $reader2.GetValue(7), $reader2.GetValue(8), $reader2.GetValue(9)) }
$conn.Close()