import { useState, useEffect } from "react";
import { Modal, Button, Typography, message, Progress, Card } from "antd";
import { TeamOutlined } from "@ant-design/icons";
import type { AIMessage } from "../types/ai";
import { useAIStore } from "../stores/aiStore";
import { createAIClient } from "../services/aiClient";

const { Title, Text, Paragraph } = Typography;

interface AgentTask {
  id: string;
  agentName: string;
  agentRole: string;
  task: string;
  status: "pending" | "working" | "completed" | "failed";
  result?: string;
  error?: string;
}

interface AIMultiAgentsProps {
  open: boolean;
  onClose: () => void;
  task: string;
}

export default function AIMultiAgents({ open, onClose, task }: AIMultiAgentsProps) {
  const { config } = useAIStore();
  const [loading, setLoading] = useState(false);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [progress, setProgress] = useState(0);

  const defaultTasks: AgentTask[] = [
    { id: "1", agentName: "架构师", agentRole: "Architecture", task: "分析项目架构并提出改进建议", status: "pending" },
    { id: "2", agentName: "开发者", agentRole: "Developer", task: "实现新功能并编写代码", status: "pending" },
    { id: "3", agentName: "测试员", agentRole: "Tester", task: "编写测试用例并验证功能", status: "pending" },
    { id: "4", agentName: "审查员", agentRole: "Reviewer", task: "代码审查并提出优化建议", status: "pending" },
  ];

  useEffect(() => {
    if (open) {
      setTasks(defaultTasks);
      setProgress(0);
    }
  }, [open]);

  const runMultiAgentTask = async () => {
    if (!task.trim() || !config.apiKey) {
      message.warning("请输入任务描述并配置 API Key");
      return;
    }

    setLoading(true);
    const newTasks = tasks.map(t => ({ ...t, status: "pending" as const }));
    setTasks(newTasks);
    setProgress(0);

    try {
      const client = createAIClient(config);
      
      // 并行执行所有智能体任务
      const agentPromises = newTasks.map(async (agentTask, index) => {
        const prompt = `你是一个${agentTask.agentRole}，你的任务是：${agentTask.task}\n\n整体项目目标：${task}\n\n请提供你的专业分析和建议。`;
        
        const messages: AIMessage[] = [
          { role: "system", content: `你是 ${agentTask.agentRole}。${agentTask.agentRole === "Architecture" ? "你负责系统架构设计和决策。" : agentTask.agentRole === "Developer" ? "你负责编写高质量的代码。" : agentTask.agentRole === "Tester" ? "你负责确保代码质量。" : "你负责代码审查和优化。"}`, timestamp: Date.now() },
          { role: "user", content: prompt, timestamp: Date.now() },
        ];

        // 模拟进度
        const progressPerAgent = 25;
        setTasks(prev => prev.map((t, i) => 
          i === index ? { ...t, status: "working" as const } : t
        ));
        setProgress(index * progressPerAgent);

        const result = await client.chat(messages, { temperature: 0.7, maxTokens: 2000 });

        setTasks(prev => prev.map((t, i) => 
          i === index ? { ...t, status: "completed" as const, result: typeof result === "string" ? result : "" } : t
        ));
        setProgress((index + 1) * progressPerAgent);

        return { agent: agentTask.agentName, result };
      });

      const results = await Promise.all(agentPromises);

      // 汇总结果
      const summaryPrompt = `以下是多智能体协作的执行结果，请生成一个综合报告：\n\n整体任务：${task}\n\n执行结果：\n${results.map(r => `### ${r.agent}\n${r.result}`).join("\n\n")}\n\n请生成一个包含主要发现、建议和行动项的综合报告。`;
      
      const summaryMessages: AIMessage[] = [
        { role: "system", content: "你是一个项目管理专家。生成简洁、全面的综合报告。", timestamp: Date.now() },
        { role: "user", content: summaryPrompt, timestamp: Date.now() },
      ];

      const summary = await client.chat(summaryMessages, { temperature: 0.7, maxTokens: 3000 });
      
      setTasks(prev => [...prev, {
        id: "summary",
        agentName: "协调员",
        agentRole: "Coordinator",
        task: "生成综合报告",
        status: "completed",
        result: typeof summary === "string" ? summary : ""
      }]);
      setProgress(100);

      message.success("多智能体协作完成！");
      setLoading(false);
    } catch (error: any) {
      console.error("Multi-agent task failed:", error);
      setTasks(prev => prev.map(t => 
        t.status === "working" ? { ...t, status: "failed", error: error.message || "未知错误" } : t
      ));
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={900}
      footer={null}
      styles={{
        body: { padding: "24px" },
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 60, height: 60, borderRadius: "50%", background: "linear-gradient(135deg, #722ed1 0%, #531dab 100%)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 24px" }}>
          <TeamOutlined style={{ fontSize: 32, color: "#fff" }} />
        </div>
        <Title level={2} style={{ margin: "0 0 16px" }}>多智能体协作</Title>
        <Paragraph type="secondary" style={{ marginBottom: "24px" }}>
          多个 AI 智能体并行协作，完成复杂的开发任务
        </Paragraph>

        <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px", marginBottom: "24px" }}>
          <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#722ed1" }}>
            📝 任务描述
          </Title>
          <Text style={{ color: "#ccc", fontSize: 14 }}>{task || "（请输入任务描述）"}</Text>
        </div>

        <div style={{ marginBottom: "24px" }}>
          <Progress percent={progress} status={loading ? "active" : "success"} strokeColor={{ "0%": "#722ed1", "100%": "#531dab" }} />
        </div>

        <div style={{ marginBottom: "24px" }}>
          <Button
            type="primary"
            icon={<TeamOutlined />}
            onClick={runMultiAgentTask}
            loading={loading}
            disabled={!task.trim() || !config.apiKey}
            style={{ minWidth: "200px" }}
          >
            {loading ? "智能体协作中..." : "开始多智能体协作"}
          </Button>
        </div>

        {tasks.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {tasks.map((taskItem) => (
              <Card
                key={taskItem.id}
                size="small"
                title={
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{
                      width: 32,
                      height: 32,
                      borderRadius: "50%",
                      background: taskItem.status === "completed" ? "linear-gradient(135deg, #52c41a 0%, #389e0d 100%)" :
                                   taskItem.status === "failed" ? "linear-gradient(135deg, #ff4d4f 0%, #cf1322 100%)" :
                                   taskItem.status === "working" ? "linear-gradient(135deg, #1890ff 0%, #0050b3 100%)" :
                                   "linear-gradient(135deg, #d9d9d9 0%, #bfbfbf 100%)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}>
                      <span style={{ color: "#fff", fontSize: 14, fontWeight: "bold" }}>{taskItem.agentName.substring(0, 2)}</span>
                    </span>
                    <div>
                      <Text strong>{taskItem.agentName}</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>({taskItem.agentRole})</Text>
                    </div>
                  </div>
                }
                extra={
                  <Text type={
                    ((): "success" | "danger" | "secondary" => {
                      if (taskItem.status === "completed") return "success";
                      if (taskItem.status === "failed") return "danger";
                      return "secondary";
                    })()
                  }>
                    {taskItem.status === "completed" ? "完成" : taskItem.status === "failed" ? "失败" : taskItem.status === "working" ? "进行中" : "待处理"}
                  </Text>
                }
                style={{
                  background: taskItem.status === "completed" ? "#f6ffed" :
                             taskItem.status === "failed" ? "#fff2f0" :
                             taskItem.status === "working" ? "#e6f7ff" :
                             "#fafafa",
                }}
              >
                <Paragraph style={{ margin: "0 0 8px 0", fontSize: 13 }} ellipsis={{ rows: 2 }}>
                  {taskItem.task}
                </Paragraph>
                
                {taskItem.status === "completed" && taskItem.result && (
                  <div style={{ background: "#000", padding: "12px", borderRadius: "4px", fontFamily: "monospace", fontSize: 12, color: "#9cdcfe" }}>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", maxHeight: "200px", overflow: "auto" }}>{taskItem.result}</pre>
                  </div>
                )}
                
                {taskItem.status === "failed" && taskItem.error && (
                  <Text type="danger" style={{ fontSize: 12 }}>
                    错误: {taskItem.error}
                  </Text>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
