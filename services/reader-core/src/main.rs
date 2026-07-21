use yomu_reader_core::app::bootstrap::run;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    run().await
}
